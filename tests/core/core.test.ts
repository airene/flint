import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  AgentRun,
  AgentRunType,
  ApprovalRequest,
  Task,
  TaskAttachment,
  TaskMessage,
} from "@local-pair-review/shared";
import {
  DatabasePorts,
  StaleRunOwnershipError,
} from "../../apps/server/src/api/database-ports";
import * as databaseModule from "../../apps/server/src/db/database";
import { ProjectService, ConfirmationRequiredError, DuplicateProjectError } from "../../apps/server/src/services/project.service";
import { AppSettingsService } from "../../apps/server/src/services/app-settings.service";
import {
  TaskService,
  DirtyWorkingTreeError,
  InvalidTaskTransitionError,
  ProjectWriteRunConflictError,
} from "../../apps/server/src/services/task.service";
import { taskStatusForRunFailure, taskStatusForRunSuccess } from "../../apps/server/src/services/task-run-state";

const temporaryDirectories: string[] = [];
const { createDatabase } = databaseModule;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "local-pair-review-core-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function repository(): string {
  const directory = temporaryDirectory();
  git(directory, "init");
  git(directory, "config", "user.email", "test@example.com");
  git(directory, "config", "user.name", "Test User");
  Bun.write(join(directory, "README.md"), "initial\n");
  git(directory, "add", "README.md");
  git(directory, "commit", "-m", "initial");
  return directory;
}

function services() {
  const database = createDatabase(join(temporaryDirectory(), "app.db"));
  return {
    database,
    projects: new ProjectService(database),
    tasks: new TaskService(database),
  };
}

function queuedRun(task: Task, runType: AgentRunType, id: string): AgentRun {
  return {
    id,
    taskId: task.id,
    projectId: task.projectId,
    provider: runType === "reviewer" ? "claude" : "codex",
    runType,
    status: "queued",
    reviewParseStatus: runType === "reviewer" ? "pending" : null,
    externalSessionId: null,
    processId: null,
    exitCode: null,
    prompt: id,
    finalMessage: null,
    structuredOutput: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("projects", () => {
  test("canonicalizes a repository subdirectory and prevents duplicate registration", async () => {
    const root = repository();
    const nested = join(root, "nested");
    mkdirSync(nested);
    const { projects } = services();

    const project = await projects.add(nested);
    expect(project.rootPath).toBe(realpathSync(root));
    await expect(projects.add(root)).rejects.toBeInstanceOf(DuplicateProjectError);
  });

  test("requires confirmation before deleting historical application data and never removes the repository", async () => {
    const root = repository();
    const { projects, tasks } = services();
    const project = await projects.add(root);
    await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });

    const unconfirmed = await projects.remove(project.id).then(() => null, (error: unknown) => error);
    expect(unconfirmed).toBeInstanceOf(ConfirmationRequiredError);
    expect((unconfirmed as ConfirmationRequiredError).data.taskCount).toBe(1);
    await projects.remove(project.id, true);
    expect(await Bun.file(join(root, ".git", "HEAD")).exists()).toBe(true);
    expect(await projects.get(project.id)).toBeNull();
  });

  test("never cascade-deletes a task inserted while unconfirmed project removal is deciding", async () => {
    const root = repository();
    const databasePath = join(temporaryDirectory(), "concurrent.db");
    const primary = createDatabase(databasePath);
    const concurrent = createDatabase(databasePath);
    const projects = new ProjectService(primary);
    const project = await projects.add(root);

    try {
      const removal = projects.remove(project.id);
      await Promise.resolve();
      await Promise.resolve();

      let insertionError: unknown;
      let inserted = false;
      try {
        concurrent.sqlite.run(
          "insert into tasks (id, project_id, title, original_prompt, working_directory, base_commit, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
          ["concurrent_task", project.id, "Concurrent", "Prompt", realpathSync(root), git(root, "rev-parse", "HEAD"), new Date().toISOString(), new Date().toISOString()],
        );
        inserted = true;
      } catch (error) {
        insertionError = error;
      }

      if (inserted) {
        await expect(removal).rejects.toBeInstanceOf(ConfirmationRequiredError);
        expect(concurrent.sqlite.query("select count(*) as count from tasks where id = 'concurrent_task'").get()).toEqual({ count: 1 });
      } else {
        await removal;
        expect(String(insertionError)).toContain("FOREIGN KEY");
      }
    } finally {
      primary.close();
      concurrent.close();
    }
  });
});

describe("run ownership", () => {
  test("does not rewrite a cancelled run during targeted recovery", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "Cancelled", originalPrompt: "Cancelled" });
    const owner = new DatabasePorts(database, undefined, { instanceId: "instance-current" });
    owner.acquireApplicationLease(101);
    try {
      await owner.queue(queuedRun(task, "developer_initial", "run-cancelled"));
      const finishedAt = "2026-07-19T00:00:05.000Z";
      database.sqlite.query("update agent_runs set status = 'cancelled', finished_at = ? where id = ?")
        .run(finishedAt, "run-cancelled");

      expect(await owner.recoverInterrupted(["run-cancelled"])).toEqual([]);
      expect(await owner.getRun("run-cancelled")).toMatchObject({ status: "cancelled", finishedAt });
    } finally {
      owner.releaseApplicationLease();
      database.close();
    }
  });

  test("fences an expired owner, terminates its process group, and rejects its late terminal write", async () => {
    const root = repository();
    const databasePath = join(temporaryDirectory(), "run-owner.db");
    const primary = createDatabase(databasePath);
    const takeover = createDatabase(databasePath);
    const projects = new ProjectService(primary);
    const taskService = new TaskService(primary);
    const project = await projects.add(root);
    const task = await taskService.create(project.id, { title: "Lease", originalPrompt: "Lease" });
    let clock = "2026-07-19T00:00:00.000Z";
    const oldOwner = new DatabasePorts(primary, undefined, {
      instanceId: "instance-old",
      leaseDurationMs: 5_000,
      now: () => clock,
    });
    const newOwner = new DatabasePorts(takeover, undefined, {
      instanceId: "instance-new",
      leaseDurationMs: 5_000,
      now: () => clock,
    });
    const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1_000)"], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      oldOwner.acquireApplicationLease(101);
      await oldOwner.queue(queuedRun(task, "developer_initial", "run-owned"));
      await oldOwner.markRunning("run-owned", child.pid);

      clock = "2026-07-19T00:00:06.000Z";
      newOwner.acquireApplicationLease(202);
      const recovered = await newOwner.recoverInterrupted();

      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ id: "run-owned", status: "interrupted", processId: null });
      expect(await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ])).toBe(true);
      await expect(oldOwner.succeed({
        runId: "run-owned",
        taskId: task.id,
        runType: "developer_initial",
        taskStatusPolicy: "transition",
        patch: {
          status: "completed",
          reviewParseStatus: null,
          exitCode: 0,
          finalMessage: "late result",
          structuredOutput: null,
          errorMessage: null,
          finishedAt: clock,
        },
      })).rejects.toBeInstanceOf(StaleRunOwnershipError);
      expect(await newOwner.getRun("run-owned")).toMatchObject({ status: "interrupted", finalMessage: null });
      expect((await taskService.get(task.id))?.status).toBe("draft");
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already stopped */ }
      newOwner.releaseApplicationLease();
      takeover.close();
      primary.close();
    }
  });

  test("records sessions against the persisted Run task and classification", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const runTask = await taskService.create(project.id, { title: "Run owner", originalPrompt: "Prompt" });
    const callerTask = await taskService.create(project.id, { title: "Caller input", originalPrompt: "Prompt" });
    const ports = new DatabasePorts(database);
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, prompt) values (?, ?, ?, 'claude', 'reviewer_followup', 'running', 'follow up')",
      ["reviewer-followup", runTask.id, project.id],
    );

    await ports.recordSession("reviewer-followup", callerTask.id, "developer_followup", "reviewer-session");
    expect(await ports.getRun("reviewer-followup")).toMatchObject({ externalSessionId: "reviewer-session" });
    expect((await taskService.get(runTask.id))?.developerSessionId).toBeNull();
    expect((await taskService.get(callerTask.id))?.developerSessionId).toBeNull();

    database.sqlite.run("update agent_runs set status = 'completed' where id = 'reviewer-followup'");
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, prompt) values (?, ?, ?, 'codex', 'developer_followup', 'running', 'continue')",
      ["developer-followup", runTask.id, project.id],
    );
    await ports.recordSession("developer-followup", callerTask.id, "reviewer_followup", "developer-session");
    expect((await taskService.get(runTask.id))?.developerSessionId).toBe("developer-session");
    expect((await taskService.get(callerTask.id))?.developerSessionId).toBeNull();
  });
});

describe("database schema policy", () => {
  const expectedTables = [
    "agent_events",
    "agent_runs",
    "app_settings",
    "application_leases",
    "approval_requests",
    "conversation_delivery_batches",
    "feedback_deliveries",
    "feedback_drafts",
    "projects",
    "review_findings",
    "review_run_snapshots",
    "run_leases",
    "task_attachments",
    "task_messages",
    "tasks",
  ];

  test("creates the complete current schema atomically with an explicit version", () => {
    const database = createDatabase(join(temporaryDirectory(), "fresh.db"));
    expect(database.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect((database.sqlite.query(
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
    ).all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expectedTables);
    expect((database.sqlite.query(
      "select sql from sqlite_schema where type = 'index' and name = 'active_write_run_per_project_unique'",
    ).get() as { sql: string }).sql).toContain("developer_followup");
    database.close();
  });

  test("rejects a non-empty database with an unknown version without mutating it", () => {
    const databasePath = join(temporaryDirectory(), "unknown-version.db");
    const legacy = new Database(databasePath);
    legacy.exec("CREATE TABLE legacy_records (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    legacy.query("INSERT INTO legacy_records VALUES (?, ?)").run("legacy-1", "preserve-me");
    legacy.exec("PRAGMA user_version = 99");
    legacy.close();

    expect(() => createDatabase(databasePath)).toThrow("schema version");
    const unchanged = new Database(databasePath);
    expect(unchanged.query("SELECT * FROM legacy_records").all()).toEqual([{
      id: "legacy-1",
      value: "preserve-me",
    }]);
    expect(unchanged.query("SELECT name FROM sqlite_schema WHERE name = 'projects'").get()).toBeNull();
    expect(unchanged.query("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    unchanged.close();
  });

  test("explicit rebuild removes legacy data and produces the complete current schema", () => {
    const databasePath = join(temporaryDirectory(), "rebuild.db");
    const legacy = new Database(databasePath);
    legacy.exec("CREATE TABLE legacy_records (id TEXT PRIMARY KEY)");
    legacy.query("INSERT INTO legacy_records VALUES (?)").run("legacy-1");
    legacy.exec("PRAGMA user_version = 99");
    legacy.close();

    const rebuild = (databaseModule as unknown as {
      rebuildDatabase?: (path: string, options: { confirmed: boolean }) => ReturnType<typeof createDatabase>;
    }).rebuildDatabase;
    expect(rebuild).toBeDefined();
    if (!rebuild) return;
    expect(() => rebuild("", { confirmed: true })).toThrow("explicit SQLite database file path");
    expect(() => rebuild(":memory:", { confirmed: true })).toThrow("explicit SQLite database file path");
    expect(() => rebuild(databasePath, { confirmed: false })).toThrow("--yes");
    const rebuilt = rebuild(databasePath, { confirmed: true });
    expect(rebuilt.sqlite.query("SELECT name FROM sqlite_schema WHERE name = 'legacy_records'").get()).toBeNull();
    expect((rebuilt.sqlite.query(
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
    ).all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(expectedTables);
    expect(rebuilt.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(rebuilt.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(rebuilt.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    rebuilt.close();
  });
});

describe("interactive workflow persistence", () => {
  test("preserves insertion FIFO for same-millisecond reverse-UUID messages and discovers queue-only conversations", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "FIFO", originalPrompt: "Prompt" });
    const ports = new DatabasePorts(database);
    const message = (id: string): TaskMessage => ({
      id,
      projectId: project.id,
      taskId: task.id,
      targetRole: "developer",
      sourceReviewRunId: null,
      text: id,
      deliveryMode: "queue",
      status: "queued",
      createdAt: "2026-07-19T00:00:01.000Z",
      updatedAt: "2026-07-19T00:00:01.000Z",
      deliveredAt: null,
      errorMessage: null,
    });

    await ports.createMessage(message("ffffffff-ffff-4fff-8fff-ffffffffffff"));
    await ports.createMessage(message("00000000-0000-4000-8000-000000000000"));

    expect((await ports.listMessages(task.id)).map(({ id }) => id)).toEqual([
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "00000000-0000-4000-8000-000000000000",
    ]);
    expect(await ports.listOpenConversationTaskIds()).toEqual([task.id]);
  });

  test("claims project-scoped attachment drafts once with their owning task message", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const otherProject = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "Attachments", originalPrompt: "Prompt" });
    const ports = new DatabasePorts(database, undefined, { now: () => "2026-07-19T00:00:01.000Z" });
    const attachment: TaskAttachment = {
      id: "attachment-1",
      projectId: project.id,
      taskId: null,
      messageId: null,
      state: "draft",
      storagePath: "/data/drafts/attachment-1.png",
      mediaType: "image/png",
      sizeBytes: 128,
      checksum: "sha256:attachment-1",
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-20T00:00:00.000Z",
      claimedAt: null,
    };
    const message: TaskMessage = {
      id: "message-1",
      projectId: project.id,
      taskId: task.id,
      targetRole: "developer",
      sourceReviewRunId: null,
      text: "Use this image",
      deliveryMode: "queue",
      status: "queued",
      createdAt: "2026-07-19T00:00:01.000Z",
      updatedAt: "2026-07-19T00:00:01.000Z",
      deliveredAt: null,
      errorMessage: null,
    };

    await ports.createAttachmentDraft(attachment);
    await ports.createMessage(message, [attachment.id]);
    expect(await ports.listMessages(task.id)).toEqual([message]);
    expect(await ports.getAttachment(attachment.id)).toMatchObject({
      state: "claimed",
      taskId: task.id,
      messageId: message.id,
      claimedAt: "2026-07-19T00:00:01.000Z",
    });

    const secondMessage = { ...message, id: "message-2", text: "Claim it again" };
    await expect(ports.createMessage(secondMessage, [attachment.id]))
      .rejects.toThrow("already claimed");
    expect(await ports.listMessages(task.id)).toEqual([message]);
    await expect(ports.createMessage({ ...message, id: "message-cross-project", projectId: otherProject.id }))
      .rejects.toThrow("does not belong");

    const expired = {
      ...attachment,
      id: "attachment-expired",
      storagePath: "/data/drafts/attachment-expired.png",
      checksum: "sha256:attachment-expired",
      expiresAt: "2026-07-19T00:00:00.500Z",
    };
    await ports.createAttachmentDraft(expired);
    await expect(ports.createMessage({
      ...message,
      id: "message-expired",
      createdAt: "2026-07-18T00:00:00.000Z",
    }, [expired.id])).rejects.toThrow("expired");
  });

  test("compares attachment expiry timestamps as instants across timezone offsets", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "Timestamp", originalPrompt: "Prompt" });
    const ports = new DatabasePorts(database, undefined, { now: () => "2026-07-19T01:00:00+01:00" });
    const attachment: TaskAttachment = {
      id: "attachment-offset",
      projectId: project.id,
      taskId: null,
      messageId: null,
      state: "draft",
      storagePath: "/data/drafts/attachment-offset.png",
      mediaType: "image/png",
      sizeBytes: 128,
      checksum: "sha256:attachment-offset",
      createdAt: "2026-07-19T00:00:00.000Z",
      expiresAt: "2026-07-19T00:30:00.000Z",
      claimedAt: null,
    };
    const message: TaskMessage = {
      id: "message-offset",
      projectId: project.id,
      taskId: task.id,
      targetRole: "developer",
      sourceReviewRunId: null,
      text: "Use the still-valid image",
      deliveryMode: "queue",
      status: "queued",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      deliveredAt: null,
      errorMessage: null,
    };

    await ports.createAttachmentDraft(attachment);
    expect(await ports.createMessage(message, [attachment.id])).toEqual(message);
  });

  test("requires reviewer messages to target a matching completed formal Review Run", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "Reviewer follow-up", originalPrompt: "Prompt" });
    const ports = new DatabasePorts(database);
    const message: TaskMessage = {
      id: "reviewer-message",
      projectId: project.id,
      taskId: task.id,
      targetRole: "reviewer",
      sourceReviewRunId: null,
      text: "Explain this finding",
      deliveryMode: "queue",
      status: "queued",
      createdAt: "2026-07-19T00:00:01.000Z",
      updatedAt: "2026-07-19T00:00:01.000Z",
      deliveredAt: null,
      errorMessage: null,
    };

    await expect(ports.createMessage(message)).rejects.toThrow("formal completed Review Run");
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, prompt) values (?, ?, ?, 'claude', 'reviewer', 'running', 'review')",
      ["formal-review", task.id, project.id],
    );
    await expect(ports.createMessage({ ...message, sourceReviewRunId: "formal-review" }))
      .rejects.toThrow("formal completed Review Run");

    database.sqlite.run("update agent_runs set status = 'completed' where id = 'formal-review'");
    expect(await ports.createMessage({ ...message, sourceReviewRunId: "formal-review" }))
      .toMatchObject({ id: message.id, sourceReviewRunId: "formal-review" });
  });

  test("reserves the first approval decision durably before completing provider relay", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "Approval", originalPrompt: "Prompt" });
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, prompt) values (?, ?, ?, 'codex', 'developer_initial', 'running', 'run')",
      ["run-approval", task.id, project.id],
    );
    const ports = new DatabasePorts(database);
    const request: ApprovalRequest = {
      id: "approval-1",
      projectId: project.id,
      taskId: task.id,
      runId: "run-approval",
      providerRequestId: "provider-request-1",
      toolName: "shell",
      actionSummary: "Run tests",
      workingDirectory: task.workingDirectory,
      status: "pending",
      decision: null,
      reason: null,
      createdAt: "2026-07-19T00:00:00.000Z",
      resolvedAt: null,
    };

    expect(await ports.createApprovalRequest(request)).toEqual(request);
    const first = await ports.reserveDecision(
      request.id,
      "allow_once",
      null,
    );
    const duplicate = await ports.reserveDecision(
      request.id,
      "deny",
      "too late",
    );
    expect(first).toMatchObject({ status: "resolving", decision: "allow_once", reason: null, resolvedAt: null });
    expect(duplicate).toEqual(first);
    expect(await ports.expireApprovals("run-approval", "2026-07-19T00:00:01.000Z")).toEqual([]);
    const resolved = await ports.completeDecision(request.id, "2026-07-19T00:00:02.000Z");
    expect(resolved).toMatchObject({ status: "resolved", decision: "allow_once" });
    expect(await ports.listPendingApprovals(task.id)).toEqual([]);

    database.sqlite.run("update agent_runs set status = 'completed' where id = 'run-approval'");
    await expect(ports.createApprovalRequest({ ...request, id: "late", providerRequestId: "late" }))
      .rejects.toThrow("is not active");
  });

  test("atomically reserves, binds, and settles durable conversation batches while preserving reviewer follow-up Task state", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "Conversation", originalPrompt: "Prompt" });
    database.sqlite.run("update tasks set status = 'ready_for_review', developer_session_id = 'developer-session' where id = ?", [task.id]);
    const ports = new DatabasePorts(database);
    const message = (id: string, createdAt: string): TaskMessage => ({
      id, projectId: project.id, taskId: task.id, targetRole: "developer", sourceReviewRunId: null,
      text: id, deliveryMode: "queue", status: "queued", createdAt, updatedAt: createdAt,
      deliveredAt: null, errorMessage: null,
    });
    await ports.createMessage(message("message-1", "2026-07-19T00:00:01.000Z"));
    await ports.createMessage(message("message-2", "2026-07-19T00:00:02.000Z"));
    const batch = await ports.reserveDeliveryBatch({
      id: "batch-1", projectId: project.id, taskId: task.id, messageIds: ["message-1", "message-2"],
      targetRole: "developer", sourceReviewRunId: null, deliveryMode: "queue", interruptedReviewRunId: null,
      createdAt: "2026-07-19T00:00:03.000Z", updatedAt: "2026-07-19T00:00:03.000Z",
    });
    expect(batch).toMatchObject({ id: "batch-1", runId: null });
    expect((await ports.listMessages(task.id)).map(({ status }) => status)).toEqual(["delivering", "delivering"]);

    const followup = queuedRun(task, "developer_followup", "conversation-run");
    await ports.queue(followup, { deliveryBatchId: "batch-1" });
    expect(await ports.listOpenDeliveryBatches(task.id)).toEqual([
      expect.objectContaining({ id: "batch-1", runId: followup.id, messageIds: ["message-1", "message-2"] }),
    ]);
    await ports.succeed({
      runId: followup.id, taskId: task.id, runType: "developer_followup", taskStatusPolicy: "transition",
      patch: {
        status: "completed", reviewParseStatus: null, exitCode: 0, finalMessage: "done",
        structuredOutput: null, errorMessage: null, finishedAt: "2026-07-19T00:00:04.000Z",
      },
    });
    const settled = await ports.settleDeliveryBatch({
      batchId: "batch-1", status: "delivered", updatedAt: "2026-07-19T00:00:05.000Z",
      deliveredAt: "2026-07-19T00:00:05.000Z", errorMessage: null,
    });
    expect(settled.map(({ status }) => status)).toEqual(["delivered", "delivered"]);
    expect(await ports.listOpenDeliveryBatches(task.id)).toEqual([]);

    database.sqlite.run("update tasks set status = 'waiting_for_human' where id = ?", [task.id]);
    const reviewerFollowup = {
      ...queuedRun(task, "reviewer_followup", "reviewer-followup-preserve"),
      provider: "claude" as const,
      externalSessionId: "reviewer-session",
    };
    await ports.queue(reviewerFollowup);
    await ports.succeed({
      runId: reviewerFollowup.id, taskId: task.id, runType: "reviewer_followup", taskStatusPolicy: "preserve_current",
      patch: {
        status: "completed", reviewParseStatus: null, exitCode: 0, finalMessage: "clarified",
        structuredOutput: null, errorMessage: null, finishedAt: "2026-07-19T00:00:06.000Z",
      },
    });
    expect((await taskService.get(task.id))?.status).toBe("waiting_for_human");
  });

  test("lists unfinished summaries and finds only the exact task provider session", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "Attention", originalPrompt: "Prompt" });
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, external_session_id, prompt, finished_at) values (?, ?, ?, 'claude', 'reviewer', 'failed', ?, 'review', ?)",
      ["run-exact", task.id, project.id, "session-exact", "2026-07-19T00:00:02.000Z"],
    );
    database.sqlite.run(
      "insert into approval_requests (id, project_id, task_id, run_id, provider_request_id, tool_name, action_summary, working_directory, status, created_at) values (?, ?, ?, ?, ?, 'shell', 'Run tests', ?, 'pending', ?)",
      ["approval-pending", project.id, task.id, "run-exact", "provider-request", task.workingDirectory, "2026-07-19T00:00:03.000Z"],
    );
    const ports = new DatabasePorts(database);

    expect(await ports.findRunBySession(task.id, "claude", "session-exact")).toMatchObject({ id: "run-exact" });
    expect(await ports.findRunBySession(task.id, "codex", "session-exact")).toBeNull();
    expect(await ports.findRunBySession("missing-task", "claude", "session-exact")).toBeNull();
    expect(await ports.listUnfinishedTasks()).toEqual([expect.objectContaining({
      id: task.id,
      projectId: project.id,
      projectName: project.name,
      title: task.title,
      latestRunStatus: "failed",
      pendingApprovalCount: 1,
      attention: "pending_approval",
    })]);
  });

  test("enforces task project ownership and one active run per task at the database boundary", async () => {
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(repository());
    const otherProject = await projects.add(repository());
    const task = await taskService.create(project.id, { title: "Invariant", originalPrompt: "Prompt" });
    const ports = new DatabasePorts(database);

    await expect(ports.queue({ ...queuedRun(task, "developer_initial", "run-wrong-project"), projectId: otherProject.id }))
      .rejects.toThrow("does not belong");
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, prompt) values (?, ?, ?, 'codex', 'developer_initial', 'queued', 'one')",
      ["run-one", task.id, project.id],
    );
    expect(() => database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, prompt) values (?, ?, ?, 'claude', 'reviewer', 'running', 'two')",
      ["run-two", task.id, project.id],
    )).toThrow();
  });
});

describe("tasks", () => {
  test("persists global role defaults and snapshots them when creating a task", async () => {
    const root = repository();
    const database = createDatabase(join(temporaryDirectory(), "settings.db"));
    const projects = new ProjectService(database);
    const settings = new AppSettingsService(database, {
      codexExecutable: "codex",
      claudeExecutable: "claude",
      gitExecutable: "git",
    });
    settings.updateSettings({ developerProvider: "claude", reviewerProvider: "codex" });
    const taskService = new TaskService(database, undefined, settings);
    const project = await projects.add(root);

    const first = await taskService.create(project.id, { title: "First", originalPrompt: "Do work" });
    expect(first).toMatchObject({ developerProvider: "claude", reviewerProvider: "codex" });
    settings.updateSettings({ developerProvider: "codex", reviewerProvider: "claude" });
    expect(settings.loadAgentRoles()).toEqual({ developerProvider: "codex", reviewerProvider: "claude" });
    expect(await taskService.get(first.id)).toMatchObject({ developerProvider: "claude", reviewerProvider: "codex" });

    const second = await taskService.create(project.id, { title: "Second", originalPrompt: "Do more work" });
    expect(second).toMatchObject({ developerProvider: "codex", reviewerProvider: "claude" });
    database.close();
  });

  test("applies partial settings patches without overwriting omitted role defaults", async () => {
    const database = createDatabase(join(temporaryDirectory(), "partial-settings.db"));
    const settings = new AppSettingsService(database, {
      codexExecutable: "codex",
      claudeExecutable: "claude",
      gitExecutable: "git",
    });

    const first = settings.updateSettings({
      codexExecutable: "/opt/codex",
      developerProvider: "claude",
    });
    expect(first).toEqual({
      cliExecutables: { codexExecutable: "/opt/codex", claudeExecutable: "claude", gitExecutable: "git" },
      roles: { developerProvider: "claude", reviewerProvider: "claude" },
    });

    await Promise.all([
      Promise.resolve().then(() => settings.updateSettings({ developerProvider: "codex" })),
      Promise.resolve().then(() => settings.updateSettings({ reviewerProvider: "codex" })),
    ]);

    expect(settings.loadAgentRoles()).toEqual({ developerProvider: "codex", reviewerProvider: "codex" });
    expect(settings.loadCliExecutables()).toEqual({ codexExecutable: "/opt/codex", claudeExecutable: "claude", gitExecutable: "git" });
    database.close();
  });

  test("requires explicit acknowledgement of a dirty working tree", async () => {
    const root = repository();
    Bun.write(join(root, "README.md"), "changed\n");
    const { projects, tasks } = services();
    const project = await projects.add(root);

    await expect(tasks.create(project.id, { title: "Task", originalPrompt: "Do work" })).rejects.toBeInstanceOf(DirtyWorkingTreeError);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work", confirmDirtyWorkingTree: true });
    expect(task.baseCommit).toBe(git(root, "rev-parse", "HEAD"));
    expect(task.workingDirectory).toBe(realpathSync(root));
  });

  test("enforces workflow transitions and uses the shared run fallback policy", async () => {
    const root = repository();
    const { projects, tasks } = services();
    const project = await projects.add(root);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });

    await expect(tasks.transition(task.id, "reviewing")).rejects.toBeInstanceOf(InvalidTaskTransitionError);
    await tasks.transition(task.id, "developing");
    expect(taskStatusForRunFailure("developer_initial", {
      hasDeveloperSession: false,
      workingTreeChanged: false,
    })).toBe("draft");
    expect(taskStatusForRunFailure("developer_initial", {
      hasDeveloperSession: true,
      workingTreeChanged: false,
    })).toBe("ready_for_review");
  });

  test("keeps a successfully finished but unparsable review available for human action", async () => {
    const root = repository();
    const { projects, tasks } = services();
    const project = await projects.add(root);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });
    await tasks.transition(task.id, "developing");
    await tasks.transition(task.id, "ready_for_review");
    expect(taskStatusForRunSuccess("reviewer")).toBe("waiting_for_human");
  });

  test("rejects a stale transition instead of overwriting a concurrent status change", async () => {
    const root = repository();
    const { database, projects, tasks } = services();
    const project = await projects.add(root);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });

    const transition = tasks.transition(task.id, "developing");
    database.sqlite.run("update tasks set status = 'completed' where id = ?", [task.id]);

    await expect(transition).rejects.toThrow("Task status changed concurrently");
    expect((await tasks.get(task.id))?.status).toBe("completed");
  });

  test("blocks project writes during review and records a review snapshot only when queueing succeeds", async () => {
    const root = repository();
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(root);
    const reviewTask = await taskService.create(project.id, { title: "Review", originalPrompt: "Review" });
    const writeTask = await taskService.create(project.id, { title: "Write", originalPrompt: "Write" });
    await taskService.transition(reviewTask.id, "developing");
    const readyReviewTask = await taskService.transition(reviewTask.id, "ready_for_review");
    const ports = new DatabasePorts(database);

    await ports.queue(queuedRun(readyReviewTask, "reviewer", "review-active"), { snapshotHash: "snapshot-accepted" });
    expect((await taskService.get(reviewTask.id))?.latestSnapshotHash).toBe("snapshot-accepted");
    expect(await ports.reviewSnapshotHash("review-active")).toBe("snapshot-accepted");
    await expect(ports.queue(queuedRun(writeTask, "developer_initial", "writer-rejected")))
      .rejects.toBeInstanceOf(ProjectWriteRunConflictError);

    database.sqlite.run("update agent_runs set status = 'completed' where id = 'review-active'");
    database.sqlite.run("update tasks set status = 'waiting_for_human' where id = ?", [reviewTask.id]);
    await ports.queue(queuedRun(writeTask, "developer_initial", "writer-active"));
    await expect(ports.queue(
      queuedRun({ ...readyReviewTask, status: "waiting_for_human" }, "reviewer", "review-rejected"),
      { snapshotHash: "snapshot-rejected" },
    )).rejects.toBeInstanceOf(ProjectWriteRunConflictError);
    expect((await taskService.get(reviewTask.id))?.latestSnapshotHash).toBe("snapshot-accepted");
    expect(await ports.reviewSnapshotHash("review-rejected")).toBeNull();
  });

  test("persists a failed developer terminal even when Git status cannot be inspected", async () => {
    const root = repository();
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(root);
    const task = await taskService.create(project.id, { title: "Fail", originalPrompt: "Fail" });
    database.sqlite.run("update tasks set status = 'developing' where id = ?", [task.id]);
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, prompt) values (?, ?, ?, 'codex', 'developer_initial', 'running', 'fail')",
      ["run-failing", task.id, task.projectId],
    );
    const brokenGit = { status: async () => { throw new Error("git unavailable"); } };
    const ports = new DatabasePorts(database, brokenGit as never);

    const terminal = await ports.fail({
      runId: "run-failing",
      taskId: task.id,
      runType: "developer_initial",
      sessionId: null,
      taskStatusPolicy: "transition",
      patch: {
        status: "failed",
        reviewParseStatus: null,
        exitCode: 1,
        finalMessage: null,
        structuredOutput: null,
        errorMessage: "driver failed",
        finishedAt: "2026-07-18T00:00:01.000Z",
      },
    });

    expect(terminal.status).toBe("failed");
    expect((await taskService.get(task.id))?.status).toBe("ready_for_review");
  });

  test("lists a reviewer that failed before process start after older completed reviews", async () => {
    const root = repository();
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(root);
    const task = await taskService.create(project.id, { title: "Order", originalPrompt: "Order" });
    const ports = new DatabasePorts(database);
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, review_parse_status, prompt, started_at, finished_at) values (?, ?, ?, 'claude', 'reviewer', 'completed', 'succeeded', 'old', ?, ?)",
      ["review-old", task.id, task.projectId, "2026-07-18T00:00:01.000Z", "2026-07-18T00:00:02.000Z"],
    );
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, review_parse_status, prompt, error_message, finished_at) values (?, ?, ?, 'claude', 'reviewer', 'failed', 'pending', 'new', 'spawn failed', ?)",
      ["review-new-failed", task.id, task.projectId, "2026-07-18T00:00:03.000Z"],
    );

    expect((await ports.listRuns(task.id)).map((run) => run.id)).toEqual(["review-old", "review-new-failed"]);
  });

  test("reads a legacy review snapshot from its persisted parsed event", async () => {
    const root = repository();
    const { database, projects, tasks: taskService } = services();
    const project = await projects.add(root);
    const task = await taskService.create(project.id, { title: "Legacy", originalPrompt: "Legacy" });
    database.sqlite.run(
      "insert into agent_runs (id, task_id, project_id, provider, run_type, status, review_parse_status, prompt, finished_at) values (?, ?, ?, 'claude', 'reviewer', 'completed', 'succeeded', 'legacy', ?)",
      ["review-legacy", task.id, task.projectId, "2026-07-18T00:00:01.000Z"],
    );
    const legacyEvent = {
      sequence: 1,
      timestamp: "2026-07-18T00:00:01.000Z",
      projectId: task.projectId,
      taskId: task.id,
      runId: "review-legacy",
      source: "system",
      type: "review_parsed",
      payload: { startSnapshotHash: "snapshot-legacy" },
    };
    database.sqlite.run(
      "insert into agent_events (id, task_id, run_id, sequence, source, event_type, raw_json, normalized_json, created_at) values (?, ?, ?, 1, 'system', 'review_parsed', '{}', ?, ?)",
      ["event-legacy", task.id, "review-legacy", JSON.stringify(legacyEvent), legacyEvent.timestamp],
    );

    expect(await new DatabasePorts(database).reviewSnapshotHash("review-legacy")).toBe("snapshot-legacy");
  });
});
