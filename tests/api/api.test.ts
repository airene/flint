import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentRun, ApprovalRequest, ReviewFinding, Task, TaskAttachmentMetadata, TaskMessage } from "@local-pair-review/shared";
import { createApplication } from "../../apps/server/src/api/application";
import { ApplicationAlreadyRunningError } from "../../apps/server/src/api/database-ports";
import { createDatabase } from "../../apps/server/src/db/database";
import { agentEvents, agentRuns, approvalRequests, projects, taskMessages, tasks } from "../../apps/server/src/db/schema";
import { createServer, type LocalPairReviewServer } from "../../apps/server/src/server";

const codexFixture = resolve(import.meta.dir, "../fixtures/bin/codex");
const claudeFixture = resolve(import.meta.dir, "../fixtures/bin/claude");
const cleanups: Array<() => Promise<void>> = [];

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-pair-review-api-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test User"],
  ]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: directory }).exitCode).toBe(0);
  }
  await Bun.write(join(directory, "README.md"), "fixture\n");
  expect(Bun.spawnSync(["git", "add", "README.md"], { cwd: directory }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "commit", "-qm", "initial"], { cwd: directory }).exitCode).toBe(0);
  return realpath(directory);
}

async function fixtureServer(scenario = "normal") {
  const environment: Record<string, string | undefined> = { ...process.env, FAKE_CLI_SCENARIO: scenario };
  const application = await createApplication({
    databasePath: ":memory:",
    codexExecutable: codexFixture,
    claudeExecutable: claudeFixture,
    gitExecutable: "git",
    environment,
  });
  const server = createServer({ application });
  cleanups.push(async () => { await server.stop(); });
  return { application, environment, server, baseUrl: `http://127.0.0.1:${server.port}` };
}

async function request<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  return { status: response.status, body: await response.json() as T };
}

async function applicationRequest<T>(
  application: Awaited<ReturnType<typeof createApplication>>,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await application.handle(new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  }));
  return { status: response.status, body: await response.json() as T };
}

async function waitForApplicationTask(
  application: Awaited<ReturnType<typeof createApplication>>,
  taskId: string,
  status: Task["status"],
): Promise<Task> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await applicationRequest<Task>(application, `/api/tasks/${taskId}`);
    if (result.body.status === status) return result.body;
    await Bun.sleep(10);
  }
  throw new Error(`Task ${taskId} did not reach ${status}`);
}

async function waitForApplicationReviewParse(
  application: Awaited<ReturnType<typeof createApplication>>,
  runId: string,
): Promise<AgentRun> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await applicationRequest<AgentRun>(application, `/api/runs/${runId}`);
    if (result.body.reviewParseStatus === "succeeded") return result.body;
    await Bun.sleep(10);
  }
  throw new Error(`Review run ${runId} did not finish parsing`);
}

async function waitForApplicationMessage(
  application: Awaited<ReturnType<typeof createApplication>>,
  taskId: string,
  messageId: string,
  status: TaskMessage["status"],
): Promise<TaskMessage> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await applicationRequest<TaskMessage[]>(application, `/api/tasks/${taskId}/messages`);
    const candidate = result.body.find((message) => message.id === messageId);
    if (candidate?.status === status) return candidate;
    await Bun.sleep(10);
  }
  throw new Error(`Message ${messageId} did not reach ${status}`);
}

async function waitForTask(baseUrl: string, taskId: string, status: Task["status"]): Promise<Task> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await request<Task>(baseUrl, `/api/tasks/${taskId}`);
    if (result.body.status === status) return result.body;
    await Bun.sleep(10);
  }
  throw new Error(`Task ${taskId} did not reach ${status}`);
}

async function waitForReviewParse(
  baseUrl: string,
  runId: string,
  status: NonNullable<AgentRun["reviewParseStatus"]>,
): Promise<AgentRun> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await request<AgentRun>(baseUrl, `/api/runs/${runId}`);
    if (result.body.reviewParseStatus === status) return result.body;
    await Bun.sleep(10);
  }
  throw new Error(`Review run ${runId} did not reach parse status ${status}`);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("local server API assembly", () => {
  test("lists project files and validates bounded queries before invoking Git", async () => {
    const rootPath = await repository();
    await Bun.write(join(rootPath, "src second.ts"), "untracked\n");
    const application = await createApplication({
      databasePath: ":memory:",
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    try {
      const created = await application.handle(new Request("http://127.0.0.1/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rootPath }),
      }));
      const project = await created.json() as { id: string };
      const call = async (path: string): Promise<{ status: number; body: { files?: string[]; code?: string } }> => {
        const response = await application.handle(new Request(`http://127.0.0.1${path}`));
        return { status: response.status, body: await response.json() as { files?: string[]; code?: string } };
      };

      const listed = await call(`/api/projects/${encodeURIComponent(project.id)}/files?q=${encodeURIComponent("src ")}&limit=1`);
      expect(listed).toEqual({ status: 200, body: { files: ["src second.ts"] } });

      for (const query of ["limit=0", "limit=51", `q=${"x".repeat(201)}`, "unexpected=1"]) {
        const invalid = await call(`/api/projects/${project.id}/files?${query}`);
        expect(invalid).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
      }
      const missing = await call("/api/projects/missing/files");
      expect(missing).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    } finally {
      await application.shutdown();
    }
  });

  test("rejects a second application on the same database before it recovers active runs", async () => {
    const rootPath = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-single-instance-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const databasePath = join(dataDirectory, "app.sqlite");
    const options = {
      databasePath,
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    };
    const first = await createApplication(options);

    try {
      const database = createDatabase(databasePath);
      const timestamp = "2026-07-19T00:00:00.000Z";
      const baseCommit = new TextDecoder().decode(
        Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: rootPath }).stdout,
      ).trim();
      database.db.insert(projects).values({
        id: "project-owned", name: "owned", rootPath,
        createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: null,
      }).run();
      database.db.insert(tasks).values({
        id: "task-owned", projectId: "project-owned", title: "owned", originalPrompt: "owned",
        workingDirectory: rootPath, baseCommit, latestSnapshotHash: null, status: "developing",
        developerSessionId: null,
        createdAt: timestamp, updatedAt: timestamp, completedAt: null,
      }).run();
      database.db.insert(agentRuns).values({
        id: "run-owned", taskId: "task-owned", projectId: "project-owned", provider: "codex",
        runType: "developer_initial", status: "running", reviewParseStatus: null,
        externalSessionId: null, processId: null, exitCode: null, prompt: "owned",
        finalMessage: null, structuredOutput: null, errorMessage: null, startedAt: timestamp, finishedAt: null,
      }).run();
      database.close();

      await expect(createApplication(options)).rejects.toBeInstanceOf(ApplicationAlreadyRunningError);
      const inspection = createDatabase(databasePath);
      try {
        expect(inspection.db.select().from(agentRuns).all().find((run) => run.id === "run-owned")?.status).toBe("running");
      } finally {
        inspection.close();
      }
    } finally {
      await first.shutdown();
    }
  });

  test("persists absolute CLI executable overrides and restores or resets them across restarts", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-settings-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const databasePath = join(dataDirectory, "app.sqlite");
    const missingCodex = join(dataDirectory, "missing-codex");
    const options = {
      databasePath,
      codexExecutable: missingCodex,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    };

    const first = await createApplication(options);
    const saved = await first.handle(new Request("http://127.0.0.1/api/system/clis/recheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codexExecutable: codexFixture }),
    }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      codex: { installed: true, executablePath: codexFixture },
    });
    await first.shutdown();

    const second = await createApplication(options);
    const restored = await second.handle(new Request("http://127.0.0.1/api/system/clis"));
    expect(await restored.json()).toMatchObject({
      codex: { installed: true, executablePath: codexFixture },
    });
    const rejected = await second.handle(new Request("http://127.0.0.1/api/system/clis/recheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codexExecutable: "relative/codex", claudeExecutable: "/also/not/written" }),
    }));
    expect(rejected.status).toBe(400);

    const reset = await second.handle(new Request("http://127.0.0.1/api/system/clis/recheck", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ codexExecutable: null }),
    }));
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ codex: { installed: false, executablePath: missingCodex } });
    await second.shutdown();
  });

  test("returns legacy role provider defaults for newly created tasks", async () => {
    const rootPath = await repository();
    const application = await createApplication({
      databasePath: ":memory:",
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    try {
      const projectResponse = await application.handle(new Request("http://127.0.0.1/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rootPath }),
      }));
      const project = await projectResponse.json() as { id: string };
      const taskResponse = await application.handle(new Request(`http://127.0.0.1/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Role defaults", originalPrompt: "Implement it" }),
      }));

      expect(taskResponse.status).toBe(201);
      expect(await taskResponse.json()).toMatchObject({ developerProvider: "codex", reviewerProvider: "claude" });
    } finally {
      await application.shutdown();
    }
  });

  test("exposes registered providers and applies saved role defaults only to new tasks", async () => {
    const rootPath = await repository();
    const application = await createApplication({
      databasePath: ":memory:",
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    try {
      const initial = await application.handle(new Request("http://127.0.0.1/api/system/settings"));
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        providers: [
          {
            id: "codex",
            roles: ["developer", "reviewer"],
            capabilities: {
              developerInitialImage: true,
              developerResumeImage: true,
              reviewerInitialImage: true,
              reviewerResumeImage: true,
            },
            availability: { installed: true },
          },
          {
            id: "claude",
            roles: ["developer", "reviewer"],
            capabilities: {
              developerInitialImage: false,
              developerResumeImage: false,
              reviewerInitialImage: false,
              reviewerResumeImage: false,
            },
            availability: { installed: true },
          },
        ],
        roles: { developerProvider: "codex", reviewerProvider: "claude" },
        git: { installed: true },
      });

      const projectResponse = await application.handle(new Request("http://127.0.0.1/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rootPath }),
      }));
      const project = await projectResponse.json() as { id: string };
      const before = await application.handle(new Request(`http://127.0.0.1/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Before role change", originalPrompt: "Implement it" }),
      }));
      const beforeTask = await before.json() as Task;

      const updated = await application.handle(new Request("http://127.0.0.1/api/system/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ developerProvider: "claude", reviewerProvider: "codex" }),
      }));
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        roles: { developerProvider: "claude", reviewerProvider: "codex" },
      });

      const after = await application.handle(new Request(`http://127.0.0.1/api/projects/${project.id}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "After role change", originalPrompt: "Implement it" }),
      }));
      expect(beforeTask).toMatchObject({ developerProvider: "codex", reviewerProvider: "claude" });
      expect(await after.json()).toMatchObject({ developerProvider: "claude", reviewerProvider: "codex" });
    } finally {
      await application.shutdown();
    }
  });

  test("uploads and securely claims initial Task images without writing them into the repository", async () => {
    const firstRoot = await repository();
    const secondRoot = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-attachment-api-"));
    const invocationLog = join(dataDirectory, "invocation.json");
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const application = await createApplication({
      databasePath: join(dataDirectory, "app.sqlite"),
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal", FAKE_CLI_INVOCATION_LOG: invocationLog },
    });
    try {
      const firstProject = await applicationRequest<{ id: string }>(application, "/api/projects", {
        method: "POST", body: JSON.stringify({ rootPath: firstRoot }),
      });
      const secondProject = await applicationRequest<{ id: string }>(application, "/api/projects", {
        method: "POST", body: JSON.stringify({ rootPath: secondRoot }),
      });
      const upload = await application.handle(new Request(
        `http://127.0.0.1/api/projects/${firstProject.body.id}/attachment-drafts`,
        {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      ));
      expect(upload.status).toBe(201);
      const draft = await upload.json() as { id: string };
      expect(draft.id).toBeTruthy();

      const wrongProject = await applicationRequest<{ code: string }>(
        application,
        `/api/projects/${secondProject.body.id}/tasks`,
        {
          method: "POST",
          body: JSON.stringify({ title: "Wrong project", originalPrompt: "Reject this", attachmentIds: [draft.id] }),
        },
      );
      expect(wrongProject).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
      expect((await applicationRequest<Task[]>(application, `/api/projects/${secondProject.body.id}/tasks`)).body).toEqual([]);

      const created = await applicationRequest<Task>(application, `/api/projects/${firstProject.body.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Image task", originalPrompt: "Use the screenshot", attachmentIds: [draft.id] }),
      });
      expect(created.status).toBe(201);
      const unfinished = await applicationRequest<Array<{ id: string; attention: string }>>(application, "/api/tasks/unfinished");
      expect(unfinished).toMatchObject({
        status: 200,
        body: [{ id: created.body.id, attention: "pending_start" }],
      });

      expect((await readdir(join(dataDirectory, "attachment-drafts"))).length).toBe(1);
      expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: firstRoot }).stdout.toString()).toBe("");

      const developed = await applicationRequest<{ run: AgentRun }>(application, `/api/tasks/${created.body.id}/develop`, {
        method: "POST", body: "{}",
      });
      expect(developed.status).toBe(202);
      await waitForApplicationTask(application, created.body.id, "ready_for_review");
      const invocation = JSON.parse(await Bun.file(invocationLog).text()) as { args: string[] };
      const imageIndex = invocation.args.indexOf("--image");
      expect(imageIndex).toBeGreaterThan(-1);
      expect(invocation.args[imageIndex + 1]).toStartWith(join(dataDirectory, "attachment-drafts"));

      const review = await applicationRequest<{ code: string; message: string }>(application, `/api/tasks/${created.body.id}/review`, {
        method: "POST", body: "{}",
      });
      expect(review).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
      expect(review.body.message).toContain("reviewer initial-run images");

      await applicationRequest(application, "/api/system/settings", {
        method: "POST", body: JSON.stringify({ reviewerProvider: "codex" }),
      });
      const secondUpload = await application.handle(new Request(
        `http://127.0.0.1/api/projects/${firstProject.body.id}/attachment-drafts`,
        { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      ));
      const secondDraft = await secondUpload.json() as { id: string };
      const codexReviewTask = await applicationRequest<Task>(application, `/api/projects/${firstProject.body.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Codex image review", originalPrompt: "Review the screenshot", attachmentIds: [secondDraft.id] }),
      });
      await applicationRequest(application, `/api/tasks/${codexReviewTask.body.id}/develop`, { method: "POST", body: "{}" });
      await waitForApplicationTask(application, codexReviewTask.body.id, "ready_for_review");
      const codexReview = await applicationRequest<{ run: AgentRun }>(application, `/api/tasks/${codexReviewTask.body.id}/review`, {
        method: "POST", body: "{}",
      });
      expect(codexReview.status).toBe(202);
      await waitForApplicationReviewParse(application, codexReview.body.run.id);
      const reviewInvocation = JSON.parse(await Bun.file(invocationLog).text()) as { args: string[] };
      expect(reviewInvocation.args).toContain("--output-schema");
      expect(reviewInvocation.args).toContain("--image");
    } finally {
      await application.shutdown();
    }
  });

  test("persists and delivers exact-session developer and selected Review messages", async () => {
    const rootPath = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-message-api-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const invocationLog = join(dataDirectory, "invocation.json");
    const application = await createApplication({
      databasePath: join(dataDirectory, "app.sqlite"),
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal", FAKE_CLI_INVOCATION_LOG: invocationLog },
    });
    try {
      await applicationRequest(application, "/api/system/settings", {
        method: "POST", body: JSON.stringify({ reviewerProvider: "codex" }),
      });
      const project = await applicationRequest<{ id: string }>(application, "/api/projects", {
        method: "POST", body: JSON.stringify({ rootPath }),
      });
      const initialUpload = await application.handle(new Request(
        `http://127.0.0.1/api/projects/${project.body.id}/attachment-drafts`,
        { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      ));
      const initialDraft = await initialUpload.json() as { id: string };
      const task = await applicationRequest<Task>(application, `/api/projects/${project.body.id}/tasks`, {
        method: "POST", body: JSON.stringify({ title: "Conversation", originalPrompt: "Build it", attachmentIds: [initialDraft.id] }),
      });
      await applicationRequest(application, `/api/tasks/${task.body.id}/develop`, { method: "POST", body: "{}" });
      await waitForApplicationTask(application, task.body.id, "ready_for_review");

      const upload = await application.handle(new Request(
        `http://127.0.0.1/api/projects/${project.body.id}/attachment-drafts`,
        { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      ));
      const draft = await upload.json() as { id: string };
      const developerMessage = await applicationRequest<TaskMessage>(application, `/api/tasks/${task.body.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          targetRole: "developer", sourceReviewRunId: null, text: "Use this image", deliveryMode: "queue", attachmentIds: [draft.id],
        }),
      });
      expect(developerMessage.status).toBe(202);
      await waitForApplicationMessage(application, task.body.id, developerMessage.body.id, "delivered");
      const attachmentHistory = await applicationRequest<TaskAttachmentMetadata[]>(
        application,
        `/api/tasks/${task.body.id}/attachments`,
      );
      expect(attachmentHistory).toMatchObject({
        status: 200,
        body: [
          { id: initialDraft.id, taskId: task.body.id, messageId: null },
          { id: draft.id, taskId: task.body.id, messageId: developerMessage.body.id },
        ],
      });
      expect(Object.keys(attachmentHistory.body[0]!).sort()).toEqual([
        "claimedAt", "createdAt", "id", "mediaType", "messageId", "projectId", "sizeBytes", "taskId",
      ]);
      const otherTask = await applicationRequest<Task>(application, `/api/projects/${project.body.id}/tasks`, {
        method: "POST", body: JSON.stringify({ title: "Other conversation", originalPrompt: "Keep attachments isolated" }),
      });
      expect((await applicationRequest<TaskAttachmentMetadata[]>(
        application,
        `/api/tasks/${otherTask.body.id}/attachments`,
      )).body).toEqual([]);
      const developerInvocation = JSON.parse(await Bun.file(invocationLog).text()) as { args: string[] };
      expect(developerInvocation.args.slice(0, 3)).toEqual(["exec", "resume", "codex-session-fake-123"]);
      expect(developerInvocation.args).toContain("--image");
      await waitForApplicationTask(application, task.body.id, "ready_for_review");

      const review = await applicationRequest<{ run: AgentRun }>(application, `/api/tasks/${task.body.id}/review`, {
        method: "POST", body: "{}",
      });
      const completedReview = await waitForApplicationReviewParse(application, review.body.run.id);
      const beforeFollowup = await applicationRequest<Task>(application, `/api/tasks/${task.body.id}`);
      expect(beforeFollowup.body.status).toBe("waiting_for_human");
      const reviewerMessage = await applicationRequest<TaskMessage>(application, `/api/tasks/${task.body.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          targetRole: "reviewer", sourceReviewRunId: review.body.run.id, text: "Clarify the finding", deliveryMode: "queue", attachmentIds: [],
        }),
      });
      await waitForApplicationMessage(application, task.body.id, reviewerMessage.body.id, "delivered");
      const runs = await applicationRequest<AgentRun[]>(application, `/api/tasks/${task.body.id}/runs`);
      expect(runs.body.at(-1)).toMatchObject({
        runType: "reviewer_followup", externalSessionId: completedReview.externalSessionId, status: "completed",
      });
      expect((await applicationRequest<Task>(application, `/api/tasks/${task.body.id}`)).body.status).toBe("waiting_for_human");
    } finally {
      await application.shutdown();
    }
  });

  test("returns persisted approvals and visibly rejects unsupported provider decisions without faking resolution", async () => {
    const rootPath = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-approval-api-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const databasePath = join(dataDirectory, "app.sqlite");
    const application = await createApplication({
      databasePath,
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    try {
      const project = await applicationRequest<{ id: string }>(application, "/api/projects", {
        method: "POST", body: JSON.stringify({ rootPath }),
      });
      const task = await applicationRequest<Task>(application, `/api/projects/${project.body.id}/tasks`, {
        method: "POST", body: JSON.stringify({ title: "Approval", originalPrompt: "Build it" }),
      });
      const started = await applicationRequest<{ run: AgentRun }>(application, `/api/tasks/${task.body.id}/develop`, {
        method: "POST", body: "{}",
      });
      await waitForApplicationTask(application, task.body.id, "ready_for_review");
      const seeded: ApprovalRequest = {
        id: "approval-api-1", projectId: project.body.id, taskId: task.body.id, runId: started.body.run.id,
        providerRequestId: "provider-approval-1", toolName: "shell", actionSummary: "Run tests",
        workingDirectory: rootPath, status: "pending", decision: null, reason: null,
        createdAt: "2026-07-19T00:00:00.000Z", resolvedAt: null,
      };
      const second = createDatabase(databasePath);
      second.db.insert(approvalRequests).values(seeded).run();
      second.close();

      expect(await applicationRequest<ApprovalRequest[]>(application, `/api/tasks/${task.body.id}/approvals`))
        .toEqual({ status: 200, body: [seeded] });
      const rejected = await applicationRequest<{ code: string; details: unknown }>(
        application,
        `/api/approvals/${seeded.id}/decision`,
        { method: "POST", body: JSON.stringify({ decision: "allow_once" }) },
      );
      expect(rejected).toMatchObject({
        status: 409,
        body: { code: "CONFLICT", details: { provider: "codex", capability: "approvals" } },
      });
      expect((await applicationRequest<ApprovalRequest[]>(application, `/api/tasks/${task.body.id}/approvals`)).body[0])
        .toMatchObject({ status: "pending", decision: null });
    } finally {
      await application.shutdown();
    }
  });

  test("publishes resolution and refreshed unfinished attention when a durable resolving approval succeeds on retry", async () => {
    const rootPath = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-approval-retry-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const databasePath = join(dataDirectory, "app.sqlite");
    const timestamp = "2026-07-19T00:00:00.000Z";
    const database = createDatabase(databasePath);
    const baseCommit = new TextDecoder().decode(
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: rootPath }).stdout,
    ).trim();
    database.db.insert(projects).values({
      id: "project-approval-retry", name: "approval-retry", rootPath,
      createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: null,
    }).run();
    database.db.insert(tasks).values({
      id: "task-approval-retry", projectId: "project-approval-retry", title: "retry", originalPrompt: "retry",
      workingDirectory: rootPath, baseCommit, latestSnapshotHash: null, status: "ready_for_review",
      developerSessionId: "codex-session-fake-123", createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    }).run();
    database.db.insert(agentRuns).values({
      id: "run-approval-retry", taskId: "task-approval-retry", projectId: "project-approval-retry", provider: "codex",
      runType: "developer_initial", status: "completed", reviewParseStatus: null,
      externalSessionId: "codex-session-fake-123", processId: null, exitCode: 0, prompt: "retry",
      finalMessage: "done", structuredOutput: null, errorMessage: null, startedAt: timestamp, finishedAt: timestamp,
    }).run();
    database.db.insert(approvalRequests).values({
      id: "approval-retry", projectId: "project-approval-retry", taskId: "task-approval-retry", runId: "run-approval-retry",
      providerRequestId: "provider-approval-retry", toolName: "shell", actionSummary: "Run tests",
      workingDirectory: rootPath, status: "resolving", decision: "allow_once", reason: null,
      createdAt: timestamp, resolvedAt: null,
    }).run();
    database.close();

    const application = await createApplication({
      databasePath,
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
      approvalControls: {
        codex: {
          capabilities: { approvals: true },
          async resolveApproval() {},
        },
      },
    });
    try {
      const taskEvents: AgentEvent[] = [];
      const unfinished: Array<{ type: string; task?: { id: string; pendingApprovalCount: number; attention: string } }> = [];
      const taskSocket = {
        getBufferedAmount: () => 0,
        send(data: string) {
          const parsed = JSON.parse(data);
          if (parsed.action === "event") taskEvents.push(parsed.event);
          return data.length;
        },
        close() {},
      };
      const unfinishedSocket = {
        getBufferedAmount: () => 0,
        send(data: string) {
          const parsed = JSON.parse(data);
          if (parsed.type === "unfinished_task_upsert") unfinished.push(parsed);
          return data.length;
        },
        close() {},
      };
      application.socketOpen(taskSocket);
      application.socketOpen(unfinishedSocket);
      await application.socketMessage(taskSocket, JSON.stringify({ action: "subscribe", taskId: "task-approval-retry", afterSequence: 0 }));
      await application.socketMessage(unfinishedSocket, JSON.stringify({ action: "subscribe_unfinished" }));

      const response = await applicationRequest<ApprovalRequest>(application, "/api/approvals/approval-retry/decision", {
        method: "POST", body: JSON.stringify({ decision: "deny", reason: "ignored retry" }),
      });

      expect(response).toMatchObject({ status: 200, body: { status: "resolved", decision: "allow_once" } });
      expect(taskEvents.at(-1)).toMatchObject({ type: "approval_resolved", payload: { approvalId: "approval-retry" } });
      expect(unfinished.at(-1)).toMatchObject({
        type: "unfinished_task_upsert",
        task: { id: "task-approval-retry", pendingApprovalCount: 0, attention: "ready_for_review" },
      });
    } finally {
      await application.shutdown();
    }
  });

  test("resumes a queue-only conversation after restart before any delivery batch was reserved", async () => {
    const rootPath = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-message-restart-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const databasePath = join(dataDirectory, "app.sqlite");
    const timestamp = "2026-07-19T00:00:00.000Z";
    const database = createDatabase(databasePath);
    const baseCommit = new TextDecoder().decode(
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: rootPath }).stdout,
    ).trim();
    database.db.insert(projects).values({
      id: "project-message-restart", name: "message-restart", rootPath,
      createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: null,
    }).run();
    database.db.insert(tasks).values({
      id: "task-message-restart", projectId: "project-message-restart", title: "restart", originalPrompt: "restart",
      workingDirectory: rootPath, baseCommit, latestSnapshotHash: null, status: "ready_for_review",
      developerSessionId: "codex-session-fake-123", createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    }).run();
    database.db.insert(taskMessages).values({
      id: "message-crash-window", projectId: "project-message-restart", taskId: "task-message-restart",
      targetRole: "developer", sourceReviewRunId: null, text: "Resume this durable message", deliveryMode: "queue",
      status: "queued", createdAt: timestamp, updatedAt: timestamp, deliveredAt: null, errorMessage: null,
    }).run();
    database.close();

    const application = await createApplication({
      databasePath,
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    try {
      expect(await waitForApplicationMessage(
        application,
        "task-message-restart",
        "message-crash-window",
        "delivered",
      )).toMatchObject({ status: "delivered" });
    } finally {
      await application.shutdown();
    }
  });

  test("keeps image drafts reusable when the selected Developer cannot receive initial images", async () => {
    const rootPath = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-attachment-capability-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const application = await createApplication({
      databasePath: join(dataDirectory, "app.sqlite"),
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      gitExecutable: "git",
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    try {
      const project = await applicationRequest<{ id: string }>(application, "/api/projects", {
        method: "POST", body: JSON.stringify({ rootPath }),
      });
      const upload = await application.handle(new Request(
        `http://127.0.0.1/api/projects/${project.body.id}/attachment-drafts`,
        {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        },
      ));
      const draft = await upload.json() as { id: string };
      await applicationRequest(application, "/api/system/settings", {
        method: "POST", body: JSON.stringify({ developerProvider: "claude" }),
      });
      const rejected = await applicationRequest<{ code: string; message: string }>(
        application,
        `/api/projects/${project.body.id}/tasks`,
        {
          method: "POST",
          body: JSON.stringify({ title: "Unsupported", originalPrompt: "Do not drop the image", attachmentIds: [draft.id] }),
        },
      );
      expect(rejected).toMatchObject({
        status: 409,
        body: { code: "CONFLICT" },
      });
      expect(rejected.body.message).toContain("initial-run images");
      expect((await applicationRequest<Task[]>(application, `/api/projects/${project.body.id}/tasks`)).body).toEqual([]);

      await applicationRequest(application, "/api/system/settings", {
        method: "POST", body: JSON.stringify({ developerProvider: "codex" }),
      });
      const retried = await applicationRequest<Task>(application, `/api/projects/${project.body.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({ title: "Supported", originalPrompt: "Deliver the image", attachmentIds: [draft.id] }),
      });
      expect(retried.status).toBe(201);
    } finally {
      await application.shutdown();
    }
  });

  test("runs the Fake CLI developer, review, finding, feedback, event replay loop", async () => {
    const rootPath = await repository();
    const { baseUrl, environment, server } = await fixtureServer();

    const createdProject = await request<{ id: string }>(baseUrl, "/api/projects", {
      method: "POST", body: JSON.stringify({ rootPath }),
    });
    expect(createdProject.status).toBe(201);
    const createdTask = await request<Task>(baseUrl, `/api/projects/${createdProject.body.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "API loop", originalPrompt: "Implement input validation." }),
    });
    expect(createdTask.status).toBe(201);
    const gitStatus = await request<{ clean: boolean; snapshotHash: string }>(baseUrl, `/api/tasks/${createdTask.body.id}/git/status`);
    expect(gitStatus.body).toMatchObject({ clean: true });
    expect(gitStatus.body.snapshotHash).toHaveLength(64);

    const developed = await request<{ run: AgentRun }>(baseUrl, `/api/tasks/${createdTask.body.id}/develop`, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(developed.status).toBe(202);
    await waitForTask(baseUrl, createdTask.body.id, "ready_for_review");

    const reviewed = await request<{ run: AgentRun }>(baseUrl, `/api/tasks/${createdTask.body.id}/review`, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(reviewed.status).toBe(202);
    await waitForTask(baseUrl, createdTask.body.id, "waiting_for_human");
    await waitForReviewParse(baseUrl, reviewed.body.run.id, "succeeded");
    const findings = await request<ReviewFinding[]>(baseUrl, `/api/tasks/${createdTask.body.id}/findings`);
    expect(findings.body).toHaveLength(1);
    expect(findings.body[0]?.selected).toBe(true);
    const noted = await request<ReviewFinding>(baseUrl, `/api/findings/${findings.body[0]!.id}`, {
      method: "PATCH", body: JSON.stringify({ userNote: "Keep the public error shape." }),
    });
    expect(noted.body.userNote).toBe("Keep the public error shape.");

    const preview = await request<{ finalText: string }>(baseUrl, `/api/tasks/${createdTask.body.id}/feedback/preview`, {
      method: "POST", body: JSON.stringify({
        sourceReviewRunId: reviewed.body.run.id,
        selectedFindingIds: [findings.body[0]!.id],
      }),
    });
    expect(preview.body.finalText).toContain("Validate input");
    const generatedDraft = await request<{
      draft: { sourceReviewRunId: string; finalText: string } | null;
    }>(baseUrl, `/api/tasks/${createdTask.body.id}/reviews/${reviewed.body.run.id}/feedback-draft`);
    expect(generatedDraft).toMatchObject({
      status: 200,
      body: { draft: { sourceReviewRunId: reviewed.body.run.id, finalText: preview.body.finalText } },
    });
    const editedDraftText = `${preview.body.finalText}\n\nManual edit for the first review.`;
    const editedDraft = await request<{ sourceReviewRunId: string; finalText: string }>(
      baseUrl,
      `/api/tasks/${createdTask.body.id}/reviews/${reviewed.body.run.id}/feedback-draft`,
      { method: "PUT", body: JSON.stringify({ finalText: editedDraftText }) },
    );
    expect(editedDraft).toMatchObject({
      status: 200,
      body: { sourceReviewRunId: reviewed.body.run.id, finalText: editedDraftText },
    });

    await Bun.write(join(rootPath, "POST_REVIEW.txt"), "changed after successful review\n");
    environment.FAKE_CLI_SCENARIO = "schema-failure";
    const failedReview = await request<{ run: AgentRun }>(baseUrl, `/api/tasks/${createdTask.body.id}/review`, {
      method: "POST", body: "{}",
    });
    await waitForTask(baseUrl, createdTask.body.id, "waiting_for_human");
    await waitForReviewParse(baseUrl, failedReview.body.run.id, "failed");
    const retained = (await request<ReviewFinding[]>(baseUrl, `/api/tasks/${createdTask.body.id}/findings`)).body;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      id: findings.body[0]!.id,
      runId: reviewed.body.run.id,
      userNote: "Keep the public error shape.",
    });

    const failedSourcePreview = await request<{ code: string }>(baseUrl, `/api/tasks/${createdTask.body.id}/feedback/preview`, {
      method: "POST", body: JSON.stringify({
        sourceReviewRunId: failedReview.body.run.id,
        selectedFindingIds: [retained[0]!.id],
      }),
    });
    expect(failedSourcePreview).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    const retainedPreview = await request<{ finalText: string }>(baseUrl, `/api/tasks/${createdTask.body.id}/feedback/preview`, {
      method: "POST", body: JSON.stringify({
        sourceReviewRunId: reviewed.body.run.id,
        selectedFindingIds: [retained[0]!.id],
      }),
    });
    expect(retainedPreview.status).toBe(200);
    expect(retainedPreview.body.finalText).toContain("Keep the public error shape.");

    environment.FAKE_CLI_SCENARIO = "normal";
    const staleFeedback = await request<{ code: string; details?: { reason?: string } }>(
      baseUrl,
      `/api/tasks/${createdTask.body.id}/feedback`,
      {
        method: "POST",
        body: JSON.stringify({
          sourceReviewRunId: reviewed.body.run.id,
          selectedFindingIds: [retained[0]!.id],
          finalText: editedDraftText,
        }),
      },
    );
    expect(staleFeedback).toMatchObject({
      status: 409,
      body: { code: "CONFLICT", details: { reason: "STALE_SNAPSHOT" } },
    });
    const feedback = await request<{ run: AgentRun; delivery: { id: string } }>(baseUrl, `/api/tasks/${createdTask.body.id}/feedback`, {
      method: "POST",
      body: JSON.stringify({
        sourceReviewRunId: reviewed.body.run.id,
        selectedFindingIds: [retained[0]!.id],
        finalText: editedDraftText,
        confirmStaleSnapshot: true,
      }),
    });
    expect(feedback.status).toBe(202);
    await waitForTask(baseUrl, createdTask.body.id, "ready_for_review");

    const latestReview = await request<{ run: AgentRun }>(baseUrl, `/api/tasks/${createdTask.body.id}/review`, {
      method: "POST", body: "{}",
    });
    await waitForTask(baseUrl, createdTask.body.id, "waiting_for_human");
    await waitForReviewParse(baseUrl, latestReview.body.run.id, "succeeded");

    const latestDraft = await request<{ draft: { finalText: string } | null }>(
      baseUrl,
      `/api/tasks/${createdTask.body.id}/reviews/${latestReview.body.run.id}/feedback-draft`,
    );
    expect(latestDraft).toMatchObject({ status: 200, body: { draft: null } });
    const retainedDraft = await request<{ draft: { sourceReviewRunId: string; finalText: string } | null }>(
      baseUrl,
      `/api/tasks/${createdTask.body.id}/reviews/${reviewed.body.run.id}/feedback-draft`,
    );
    expect(retainedDraft).toMatchObject({
      status: 200,
      body: { draft: { sourceReviewRunId: reviewed.body.run.id, finalText: editedDraftText } },
    });

    const reviewHistory = (await request<ReviewFinding[]>(baseUrl, `/api/tasks/${createdTask.body.id}/findings`)).body;
    expect(reviewHistory).toHaveLength(2);
    expect(reviewHistory.find((finding) => finding.runId === reviewed.body.run.id)).toMatchObject({
      userNote: "Keep the public error shape.",
      selected: true,
    });
    const latestFinding = reviewHistory.find((finding) => finding.runId === latestReview.body.run.id)!;
    const latestSelection = await request<ReviewFinding[]>(baseUrl, `/api/tasks/${createdTask.body.id}/findings/select`, {
      method: "POST",
      body: JSON.stringify({ sourceReviewRunId: latestReview.body.run.id, mode: "none" }),
    });
    expect(latestSelection.status).toBe(200);
    expect(latestSelection.body).toHaveLength(1);
    expect(latestSelection.body[0]).toMatchObject({ id: latestFinding.id, selected: false });
    const afterLatestSelection = (await request<ReviewFinding[]>(baseUrl, `/api/tasks/${createdTask.body.id}/findings`)).body;
    expect(afterLatestSelection.find((finding) => finding.runId === reviewed.body.run.id)).toMatchObject({
      userNote: "Keep the public error shape.",
      selected: true,
    });

    const completed = await request<Task>(baseUrl, `/api/tasks/${createdTask.body.id}/complete`, {
      method: "POST", body: "{}",
    });
    expect(completed.body.status).toBe("completed");

    const runs = await request<AgentRun[]>(baseUrl, `/api/tasks/${createdTask.body.id}/runs`);
    expect(runs.body.map((run) => run.runType)).toEqual(["developer_initial", "reviewer", "reviewer", "developer_feedback", "reviewer"]);
    expect(runs.body.map((run) => run.status)).toEqual(["completed", "completed", "completed", "completed", "completed"]);

    const events: AgentEvent[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ action: "subscribe", taskId: createdTask.body.id, afterSequence: 0 }));
      });
      socket.addEventListener("message", (message) => {
        const parsed = JSON.parse(String(message.data));
        if (parsed.action === "event") events.push(parsed.event);
        if (events.length >= 10) resolveOpen();
      });
      socket.addEventListener("error", reject);
      setTimeout(() => reject(new Error("WebSocket replay timed out")), 1_000);
    });
    socket.close();
    expect(events.length).toBeGreaterThanOrEqual(10);
    expect(events.map((event) => event.sequence)).toEqual([...events.map((event) => event.sequence)].sort((a, b) => a - b));
  });

  test("maps validation, missing resources, and concurrent project writes to stable errors", async () => {
    const rootPath = await repository();
    const { baseUrl } = await fixtureServer("slow");
    const invalid = await request<{ code: string }>(baseUrl, "/api/projects", {
      method: "POST", body: JSON.stringify({ rootPath: "" }),
    });
    expect(invalid).toMatchObject({ status: 400, body: { code: "VALIDATION_ERROR" } });
    const crossOrigin = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "text/plain" },
      body: JSON.stringify({ rootPath }),
    });
    expect(crossOrigin.status).toBe(403);
    const wrongContentType = await fetch(`${baseUrl}/api/projects`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ rootPath }),
    });
    expect(wrongContentType.status).toBe(400);
    expect(await wrongContentType.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Write requests require application/json.",
    });
    const missing = await request<{ code: string }>(baseUrl, "/api/tasks/missing");
    expect(missing).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });

    const project = await request<{ id: string }>(baseUrl, "/api/projects", {
      method: "POST", body: JSON.stringify({ rootPath }),
    });
    const first = await request<Task>(baseUrl, `/api/projects/${project.body.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "one", originalPrompt: "one" }),
    });
    const second = await request<Task>(baseUrl, `/api/projects/${project.body.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "two", originalPrompt: "two" }),
    });
    await request(baseUrl, `/api/tasks/${first.body.id}/develop`, { method: "POST", body: "{}" });
    const conflict = await request<{ code: string }>(baseUrl, `/api/tasks/${second.body.id}/develop`, {
      method: "POST", body: "{}",
    });
    expect(conflict).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    const deleteConflict = await request<{ code: string }>(baseUrl, `/api/projects/${project.body.id}`, {
      method: "DELETE", body: JSON.stringify({ confirm: true }),
    });
    expect(deleteConflict).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
  });

  test("rechecks provider availability before starting a run", async () => {
    const rootPath = await repository();
    const executableDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-cli-refresh-"));
    cleanups.push(() => rm(executableDirectory, { recursive: true, force: true }));
    const temporaryCodex = join(executableDirectory, "codex");
    await copyFile(codexFixture, temporaryCodex);
    await chmod(temporaryCodex, 0o755);
    const application = await createApplication({
      databasePath: ":memory:", codexExecutable: temporaryCodex, claudeExecutable: claudeFixture,
      gitExecutable: "git", environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    cleanups.push(() => application.shutdown());
    const project = await applicationRequest<{ id: string }>(application, "/api/projects", {
      method: "POST", body: JSON.stringify({ rootPath }),
    });
    const task = await applicationRequest<Task>(application, `/api/projects/${project.body.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "fresh CLI", originalPrompt: "fresh CLI" }),
    });
    await rm(temporaryCodex);

    const started = await applicationRequest<{ code: string; details?: { provider?: string } }>(
      application,
      `/api/tasks/${task.body.id}/develop`,
      { method: "POST", body: "{}" },
    );
    expect(started).toMatchObject({
      status: 422,
      body: { code: "CLI_UNAVAILABLE", details: { provider: "codex" } },
    });
  });

  test("keeps persisted task history readable when its repository is deleted", async () => {
    const rootPath = await repository();
    const application = await createApplication({
      databasePath: ":memory:", codexExecutable: codexFixture, claudeExecutable: claudeFixture,
      gitExecutable: "git", environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    cleanups.push(() => application.shutdown());
    const project = await applicationRequest<{ id: string }>(application, "/api/projects", {
      method: "POST", body: JSON.stringify({ rootPath }),
    });
    const task = await applicationRequest<Task>(application, `/api/projects/${project.body.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "persisted history", originalPrompt: "persisted history" }),
    });
    await applicationRequest(application, `/api/tasks/${task.body.id}/develop`, { method: "POST", body: "{}" });
    await waitForApplicationTask(application, task.body.id, "ready_for_review");
    await rm(rootPath, { recursive: true, force: true });

    const persistedTask = await applicationRequest<Task>(application, `/api/tasks/${task.body.id}`);
    const runs = await applicationRequest<AgentRun[]>(application, `/api/tasks/${task.body.id}/runs`);
    const findings = await applicationRequest<ReviewFinding[]>(application, `/api/tasks/${task.body.id}/findings`);
    const repositoryStatus = await applicationRequest<{ code: string; details?: { provider?: string } }>(
      application,
      `/api/tasks/${task.body.id}/git/status`,
    );

    expect(persistedTask).toMatchObject({ status: 200, body: { id: task.body.id, status: "ready_for_review" } });
    expect(runs).toMatchObject({ status: 200, body: [{ taskId: task.body.id, status: "completed" }] });
    expect(findings).toEqual({ status: 200, body: [] });
    expect(repositoryStatus).toMatchObject({
      status: 422,
      body: { code: "CLI_UNAVAILABLE", details: { provider: "git" } },
    });
  });

  test("maps a missing Git executable for task creation, review, feedback, and Git routes", async () => {
    const rootPath = await repository();
    const application = await createApplication({
      databasePath: ":memory:", codexExecutable: codexFixture, claudeExecutable: claudeFixture,
      gitExecutable: "git", environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    cleanups.push(() => application.shutdown());
    const project = await applicationRequest<{ id: string }>(application, "/api/projects", {
      method: "POST", body: JSON.stringify({ rootPath }),
    });
    const task = await applicationRequest<Task>(application, `/api/projects/${project.body.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "existing task", originalPrompt: "existing task" }),
    });
    await applicationRequest(application, `/api/tasks/${task.body.id}/develop`, { method: "POST", body: "{}" });
    await waitForApplicationTask(application, task.body.id, "ready_for_review");
    const reviewed = await applicationRequest<{ run: AgentRun }>(application, `/api/tasks/${task.body.id}/review`, {
      method: "POST", body: "{}",
    });
    await waitForApplicationTask(application, task.body.id, "waiting_for_human");
    await waitForApplicationReviewParse(application, reviewed.body.run.id);
    const [finding] = (await applicationRequest<ReviewFinding[]>(application, `/api/tasks/${task.body.id}/findings`)).body;
    const missingGit = join(rootPath, "missing-git");
    const settings = await applicationRequest<{ git: { installed: boolean } }>(application, "/api/system/settings", {
      method: "POST", body: JSON.stringify({ gitExecutable: missingGit }),
    });
    expect(settings).toMatchObject({ status: 200, body: { git: { installed: false } } });

    const createTask = await applicationRequest<{ code: string; details?: { provider?: string } }>(
      application,
      `/api/projects/${project.body.id}/tasks`,
      { method: "POST", body: JSON.stringify({ title: "blocked", originalPrompt: "blocked" }) },
    );
    const review = await applicationRequest<{ code: string; details?: { provider?: string } }>(
      application,
      `/api/tasks/${task.body.id}/review`,
      { method: "POST", body: "{}" },
    );
    const gitStatus = await applicationRequest<{ code: string; details?: { provider?: string } }>(
      application,
      `/api/tasks/${task.body.id}/git/status`,
    );
    const projectFiles = await applicationRequest<{ code: string; details?: { provider?: string } }>(
      application,
      `/api/projects/${project.body.id}/files?q=src`,
    );
    const feedback = await applicationRequest<{ code: string; details?: { provider?: string } }>(
      application,
      `/api/tasks/${task.body.id}/feedback`,
      {
        method: "POST",
        body: JSON.stringify({
          sourceReviewRunId: reviewed.body.run.id,
          selectedFindingIds: finding ? [finding.id] : [],
          finalText: "Apply the reviewed changes.",
        }),
      },
    );

    for (const response of [createTask, review, gitStatus, projectFiles, feedback]) {
      expect(response).toMatchObject({
        status: 422,
        body: { code: "CLI_UNAVAILABLE", details: { provider: "git" } },
      });
    }
  });

  test("keeps completed review findings read-only", async () => {
    const rootPath = await repository();
    const { baseUrl } = await fixtureServer();
    const project = await request<{ id: string }>(baseUrl, "/api/projects", {
      method: "POST", body: JSON.stringify({ rootPath }),
    });
    const task = await request<Task>(baseUrl, `/api/projects/${project.body.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "history", originalPrompt: "history" }),
    });
    await request(baseUrl, `/api/tasks/${task.body.id}/develop`, { method: "POST", body: "{}" });
    await waitForTask(baseUrl, task.body.id, "ready_for_review");
    const reviewed = await request<{ run: AgentRun }>(baseUrl, `/api/tasks/${task.body.id}/review`, {
      method: "POST", body: "{}",
    });
    await waitForTask(baseUrl, task.body.id, "waiting_for_human");
    await waitForReviewParse(baseUrl, reviewed.body.run.id, "succeeded");
    const [finding] = (await request<ReviewFinding[]>(baseUrl, `/api/tasks/${task.body.id}/findings`)).body;
    const preview = await request<{ finalText: string }>(baseUrl, `/api/tasks/${task.body.id}/feedback/preview`, {
      method: "POST",
      body: JSON.stringify({ sourceReviewRunId: reviewed.body.run.id, selectedFindingIds: [finding!.id] }),
    });
    await request(baseUrl, `/api/tasks/${task.body.id}/complete`, { method: "POST", body: "{}" });

    const updated = await request<{ code: string }>(baseUrl, `/api/findings/${finding!.id}`, {
      method: "PATCH", body: JSON.stringify({ selected: false, userNote: "mutated" }),
    });
    const selected = await request<{ code: string }>(baseUrl, `/api/tasks/${task.body.id}/findings/select`, {
      method: "POST", body: JSON.stringify({ sourceReviewRunId: reviewed.body.run.id, mode: "none" }),
    });
    const persistedDraft = await request<{ draft: { finalText: string } | null }>(
      baseUrl,
      `/api/tasks/${task.body.id}/reviews/${reviewed.body.run.id}/feedback-draft`,
    );
    const updatedDraft = await request<{ code: string }>(
      baseUrl,
      `/api/tasks/${task.body.id}/reviews/${reviewed.body.run.id}/feedback-draft`,
      { method: "PUT", body: JSON.stringify({ finalText: "mutated" }) },
    );

    expect(updated).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    expect(selected).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    expect(persistedDraft).toMatchObject({ status: 200, body: { draft: { finalText: preview.body.finalText } } });
    expect(updatedDraft).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    expect((await request<ReviewFinding[]>(baseUrl, `/api/tasks/${task.body.id}/findings`)).body[0]).toMatchObject({
      selected: true,
      userNote: null,
    });

    expect((await request<Task>(baseUrl, `/api/tasks/${task.body.id}`)).body.originalPrompt).toBe("history");
  });

  test("recovers persisted active runs as interrupted and restores a usable task state", async () => {
    const rootPath = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-recovery-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const databasePath = join(dataDirectory, "app.sqlite");
    const database = createDatabase(databasePath);
    const baseCommit = new TextDecoder().decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: rootPath }).stdout).trim();
    const timestamp = "2026-07-18T00:00:00.000Z";
    database.db.insert(projects).values({
      id: "project-recovery", name: "recovery", rootPath,
      createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: null,
    }).run();
    database.db.insert(tasks).values({
      id: "task-recovery", projectId: "project-recovery", title: "recover", originalPrompt: "recover",
      workingDirectory: rootPath, baseCommit, latestSnapshotHash: null, status: "developing",
      developerSessionId: null,
      createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    }).run();
    database.db.insert(agentRuns).values({
      id: "run-recovery", taskId: "task-recovery", projectId: "project-recovery", provider: "codex",
      runType: "developer_initial", status: "running", reviewParseStatus: null,
      externalSessionId: null, processId: 999_999, exitCode: null, prompt: "recover",
      finalMessage: null, structuredOutput: null, errorMessage: null, startedAt: timestamp, finishedAt: null,
    }).run();
    database.db.insert(approvalRequests).values({
      id: "approval-recovery", projectId: "project-recovery", taskId: "task-recovery", runId: "run-recovery",
      providerRequestId: "provider-recovery", toolName: "shell", actionSummary: "Recover approval",
      workingDirectory: rootPath, status: "pending", decision: null, reason: null,
      createdAt: timestamp, resolvedAt: null,
    }).run();
    database.close();
    await rm(rootPath, { recursive: true, force: true });

    const application = await createApplication({
      databasePath,
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    cleanups.push(async () => { await application.shutdown(); });

    expect((await applicationRequest<Task>(application, "/api/tasks/task-recovery")).body.status).toBe("ready_for_review");
    expect((await applicationRequest<AgentRun>(application, "/api/runs/run-recovery")).body).toMatchObject({
      status: "interrupted", processId: null, externalSessionId: null,
    });
    expect((await applicationRequest<ApprovalRequest[]>(application, "/api/tasks/task-recovery/approvals")).body)
      .toEqual([expect.objectContaining({ id: "approval-recovery", status: "expired", resolvedAt: expect.any(String) })]);
  });

  test("graceful shutdown terminates an active process and persists interrupted", async () => {
    const rootPath = await repository();
    const dataDirectory = await mkdtemp(join(tmpdir(), "local-pair-review-shutdown-"));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const databasePath = join(dataDirectory, "app.sqlite");
    const application = await createApplication({
      databasePath,
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      environment: { ...process.env, FAKE_CLI_SCENARIO: "slow" },
    });
    const server = createServer({ application });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const project = await request<{ id: string }>(baseUrl, "/api/projects", {
      method: "POST", body: JSON.stringify({ rootPath }),
    });
    const task = await request<Task>(baseUrl, `/api/projects/${project.body.id}/tasks`, {
      method: "POST", body: JSON.stringify({ title: "shutdown", originalPrompt: "shutdown" }),
    });
    const started = await request<{ run: AgentRun }>(baseUrl, `/api/tasks/${task.body.id}/develop`, {
      method: "POST", body: "{}",
    });

    await server.stop();
    const reopened = createDatabase(databasePath);
    try {
      const stored = reopened.db.select().from(agentRuns).all();
      expect(stored.find((run) => run.id === started.body.run.id)).toMatchObject({ status: "interrupted", processId: null });
      const lifecycle = reopened.db.select().from(agentEvents).all().map((event) => event.eventType);
      expect(lifecycle).toContain("run_interrupted");
      expect(lifecycle).not.toContain("run_cancelled");
    } finally {
      reopened.close();
    }
  });
});
