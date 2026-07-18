import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentRun, ReviewFinding, Task } from "@local-pair-review/shared";
import { createApplication } from "../../apps/server/src/api/application";
import { createDatabase } from "../../apps/server/src/db/database";
import { agentEvents, agentRuns, projects, tasks } from "../../apps/server/src/db/schema";
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
          { id: "codex", roles: ["developer", "reviewer"], availability: { installed: true } },
          { id: "claude", roles: ["developer", "reviewer"], availability: { installed: true } },
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
          finalText: retainedPreview.body.finalText,
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
        finalText: retainedPreview.body.finalText,
        confirmStaleSnapshot: true,
      }),
    });
    expect(feedback.status).toBe(202);
    await waitForTask(baseUrl, createdTask.body.id, "ready_for_review");

    await request(baseUrl, `/api/tasks/${createdTask.body.id}/review`, { method: "POST", body: "{}" });
    await waitForTask(baseUrl, createdTask.body.id, "waiting_for_human");
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
    await request(baseUrl, `/api/tasks/${task.body.id}/complete`, { method: "POST", body: "{}" });

    const updated = await request<{ code: string }>(baseUrl, `/api/findings/${finding!.id}`, {
      method: "PATCH", body: JSON.stringify({ selected: false, userNote: "mutated" }),
    });
    const selected = await request<{ code: string }>(baseUrl, `/api/tasks/${task.body.id}/findings/select`, {
      method: "POST", body: JSON.stringify({ mode: "none" }),
    });

    expect(updated).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    expect(selected).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    expect((await request<ReviewFinding[]>(baseUrl, `/api/tasks/${task.body.id}/findings`)).body[0]).toMatchObject({
      selected: true,
      userNote: null,
    });

    const patched = await request<{ code: string }>(baseUrl, `/api/tasks/${task.body.id}`, {
      method: "PATCH", body: JSON.stringify({ originalPrompt: "mutated" }),
    });
    expect(patched).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
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
      defaultDeveloper: "codex", defaultReviewer: "claude",
      createdAt: timestamp, updatedAt: timestamp, lastOpenedAt: null,
    }).run();
    database.db.insert(tasks).values({
      id: "task-recovery", projectId: "project-recovery", title: "recover", originalPrompt: "recover",
      workingDirectory: rootPath, baseCommit, latestSnapshotHash: null, status: "developing",
      developerSessionId: null, reviewerSessionId: null,
      createdAt: timestamp, updatedAt: timestamp, completedAt: null,
    }).run();
    database.db.insert(agentRuns).values({
      id: "run-recovery", taskId: "task-recovery", projectId: "project-recovery", provider: "codex",
      runType: "developer_initial", status: "running", reviewParseStatus: null,
      externalSessionId: null, processId: 999_999, exitCode: null, prompt: "recover",
      finalMessage: null, structuredOutput: null, errorMessage: null, startedAt: timestamp, finishedAt: null,
    }).run();
    database.close();
    await rm(rootPath, { recursive: true, force: true });

    const application = await createApplication({
      databasePath,
      codexExecutable: codexFixture,
      claudeExecutable: claudeFixture,
      environment: { ...process.env, FAKE_CLI_SCENARIO: "normal" },
    });
    const server = createServer({ application });
    cleanups.push(async () => { await server.stop(); });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    expect((await request<Task>(baseUrl, "/api/tasks/task-recovery")).body.status).toBe("ready_for_review");
    expect((await request<AgentRun>(baseUrl, "/api/runs/run-recovery")).body).toMatchObject({
      status: "interrupted", processId: null, externalSessionId: null,
    });
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
