import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AgentRun, AgentRunType, Task } from "@local-pair-review/shared";
import { DatabasePorts, StaleRunOwnershipError } from "../../apps/server/src/api/database-ports";
import { createDatabase } from "../../apps/server/src/db/database";
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

    await expect(projects.remove(project.id)).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect((await projects.removalInfo(project.id)).taskCount).toBe(1);
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
});

describe("tasks", () => {
  test("migrates legacy tasks with the original Codex developer and Claude reviewer defaults", () => {
    const databasePath = join(temporaryDirectory(), "legacy.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        default_developer TEXT NOT NULL DEFAULT 'codex', default_reviewer TEXT NOT NULL DEFAULT 'claude',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, original_prompt TEXT NOT NULL,
        working_directory TEXT NOT NULL, base_commit TEXT NOT NULL, latest_snapshot_hash TEXT, status TEXT NOT NULL,
        developer_session_id TEXT, reviewer_session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO projects VALUES ('project_legacy', 'Legacy', '/tmp/legacy', 'codex', 'claude', '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z', NULL);
      INSERT INTO tasks VALUES ('task_legacy', 'project_legacy', 'Legacy task', 'Prompt', '/tmp/legacy', 'abc123', NULL, 'draft', NULL, NULL, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z', NULL);
    `);
    legacy.close();

    const migrated = createDatabase(databasePath);
    try {
      expect(migrated.sqlite.query("select developer_provider, reviewer_provider from tasks where id = 'task_legacy'").get())
        .toEqual({ developer_provider: "codex", reviewer_provider: "claude" });
      createDatabase(databasePath).close();
    } finally {
      migrated.close();
    }
  });

  test("persists global role defaults and snapshots them when creating a task", async () => {
    const root = repository();
    const database = createDatabase(join(temporaryDirectory(), "settings.db"));
    const projects = new ProjectService(database);
    const settings = new AppSettingsService(database, {
      codexExecutable: "codex",
      claudeExecutable: "claude",
      gitExecutable: "git",
    });
    settings.updateAgentRoles({ developerProvider: "claude", reviewerProvider: "codex" });
    const taskService = new TaskService(database, undefined, settings);
    const project = await projects.add(root);

    const first = await taskService.create(project.id, { title: "First", originalPrompt: "Do work" });
    expect(first).toMatchObject({ developerProvider: "claude", reviewerProvider: "codex" });
    settings.updateAgentRoles({ developerProvider: "codex", reviewerProvider: "claude" });
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
