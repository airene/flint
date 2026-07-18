import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentStartRequest } from "@local-pair-review/shared";
import { checkGitAvailability } from "../../apps/server/src/drivers/cli-availability";
import { ClaudeCliDriver } from "../../apps/server/src/drivers/claude-cli.driver";
import { CodexCliDriver } from "../../apps/server/src/drivers/codex-cli.driver";
import { AgentProcessError } from "../../apps/server/src/utils/process-supervisor";

const codexFixture = join(import.meta.dir, "../fixtures/bin/codex");
const claudeFixture = join(import.meta.dir, "../fixtures/bin/claude");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-pair-review-agent-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function request(workingDirectory: string, overrides: Partial<AgentStartRequest> = {}): AgentStartRequest {
  return {
    runId: "run-fake-1",
    taskId: "task-fake-1",
    projectId: "project-fake-1",
    workingDirectory,
    prompt: "Perform the fake task without contacting a model.",
    ...overrides,
  };
}

function environment(scenario: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { ...process.env, FAKE_CLI_SCENARIO: scenario, ...extra };
}

describe("CLI availability", () => {
  test("reports Codex version with unknown auth and Claude subscription auth", async () => {
    const codex = new CodexCliDriver({ executablePath: codexFixture, environment: environment("normal") });
    const claude = new ClaudeCliDriver({ executablePath: claudeFixture, environment: environment("normal") });

    expect(await codex.checkAvailability()).toEqual({
      installed: true,
      executablePath: codexFixture,
      version: "codex-cli 9.9.9-fake",
      authentication: "unknown",
      message: null,
    });
    expect(await claude.checkAvailability()).toEqual({
      installed: true,
      executablePath: claudeFixture,
      version: "claude-code 8.8.8-fake",
      authentication: "authenticated",
      message: null,
    });
  });

  test("reports explicit Claude unauthenticated state and missing Git", async () => {
    const claude = new ClaudeCliDriver({ executablePath: claudeFixture, environment: environment("unauthenticated") });
    const git = await checkGitAvailability("/definitely/missing/git", environment("normal"));

    const claudeStatus = await claude.checkAvailability();
    expect(claudeStatus.authentication).toBe("unauthenticated");
    expect(claudeStatus.message).toContain("[REDACTED]");
    expect(claudeStatus.message).not.toContain("sk-fake-auth-secret");
    expect(git).toMatchObject({ installed: false, executablePath: null, authentication: "unknown" });
  });
});

describe("Codex driver", () => {
  test("streams complete events, stdin, explicit cwd, and exact resume arguments", async () => {
    const directory = await workspace();
    const log = join(directory, "invocation.json");
    const events: AgentEvent[] = [];
    const driver = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("resume", { FAKE_CLI_INVOCATION_LOG: log }),
    });

    const result = await driver.start(request(directory, { sessionId: "thread-exact-resume" }), async (event) => {
      events.push(event);
    });
    const invocation = JSON.parse(await readFile(log, "utf8"));

    expect(result).toEqual({
      sessionId: "thread-exact-resume",
      finalMessage: "Fake Codex completed the requested change.",
      structuredOutput: null,
    });
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "session_started",
      "turn_started",
      "message",
      "turn_completed",
    ]);
    expect(invocation.args).toEqual(["exec", "resume", "thread-exact-resume", "--json", "-"]);
    expect(invocation.cwd).toBe(await realpath(directory));
    expect(invocation.prompt).toBe("Perform the fake task without contacting a model.");
  });

  test("continues after invalid and unknown lines and preserves stderr", async () => {
    const directory = await workspace();
    const invalidEvents: AgentEvent[] = [];
    const invalidDriver = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("invalid-json"),
    });
    const stderrEvents: AgentEvent[] = [];
    const stderrDriver = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("stderr"),
    });

    await invalidDriver.start(request(directory), async (event) => { invalidEvents.push(event); });
    await stderrDriver.start(request(directory, { runId: "run-stderr" }), async (event) => { stderrEvents.push(event); });

    expect(invalidEvents.filter((event) => event.type === "raw")).toHaveLength(2);
    expect(stderrEvents.find((event) => event.type === "stderr")?.payload).toEqual({ raw: "fake warning from stderr" });
  });

  test("classifies nonzero exits, failed turns, and incomplete streams as failures", async () => {
    const directory = await workspace();

    for (const scenario of ["nonzero", "turn-failed", "incomplete", "terminate"]) {
      const driver = new CodexCliDriver({ executablePath: codexFixture, environment: environment(scenario) });
      await expect(driver.start(request(directory, { runId: `run-${scenario}` }), async () => {}))
        .rejects.toBeInstanceOf(AgentProcessError);
    }
  });

  test("cancels a slow run within the grace/force termination path", async () => {
    const directory = await workspace();
    const events: AgentEvent[] = [];
    const driver = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("slow"),
      cancellationGraceMs: 25,
    });

    const running = driver.start(request(directory, { runId: "run-slow" }), async (event) => { events.push(event); });
    const settled = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    while (!events.some((event) => event.type === "session_started")) await Bun.sleep(5);
    await driver.cancel("run-slow");

    expect(await settled).toMatchObject({ kind: "cancelled" });
  });

  test("terminates descendants when cancelling a process tree", async () => {
    const directory = await workspace();
    const childPidLog = join(directory, "child.pid");
    const heartbeatLog = join(directory, "child.heartbeat");
    const events: AgentEvent[] = [];
    const driver = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("slow-tree", {
        FAKE_CLI_CHILD_PID_LOG: childPidLog,
        FAKE_CLI_HEARTBEAT_LOG: heartbeatLog,
      }),
      cancellationGraceMs: 25,
    });
    const running = driver.start(request(directory, { runId: "run-slow-tree" }), async (event) => { events.push(event); });
    const settled = running.then(() => undefined, (error: unknown) => error);
    while (!events.some((event) => event.type === "session_started")) await Bun.sleep(5);
    let childPid = 0;
    while (!childPid) {
      try { childPid = Number(await readFile(childPidLog, "utf8")); } catch { await Bun.sleep(5); }
    }
    while (true) {
      try { await readFile(heartbeatLog, "utf8"); break; } catch { await Bun.sleep(5); }
    }

    let stoppedHeartbeat = "";
    try {
      await driver.cancel("run-slow-tree");
      expect(await settled).toMatchObject({ kind: "cancelled" });
      await Bun.sleep(25);
      stoppedHeartbeat = await readFile(heartbeatLog, "utf8");
      await Bun.sleep(100);
      expect(await readFile(heartbeatLog, "utf8")).toBe(stoppedHeartbeat);
    } finally {
      const latestHeartbeat = await readFile(heartbeatLog, "utf8").catch(() => "");
      if (stoppedHeartbeat && latestHeartbeat !== stoppedHeartbeat) process.kill(childPid, "SIGKILL");
    }
  });
});

describe("Claude driver", () => {
  test("streams the complete structured result and enforces CLI read-only arguments", async () => {
    const directory = await workspace();
    const log = join(directory, "invocation.json");
    const events: AgentEvent[] = [];
    const driver = new ClaudeCliDriver({
      executablePath: claudeFixture,
      environment: environment("normal", { FAKE_CLI_INVOCATION_LOG: log }),
    });

    const result = await driver.start(request(directory), async (event) => { events.push(event); });
    const invocation = JSON.parse(await readFile(log, "utf8"));

    expect(result.sessionId).toBe("claude-session-fake-456");
    expect(result.finalMessage).toBe("Fake Claude review completed.");
    expect(result.structuredOutput).toMatchObject({ verdict: "changes_suggested", findings: [expect.any(Object)] });
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "session_started",
      "message",
      "turn_completed",
    ]);
    expect(invocation.args).toContain("--permission-mode");
    expect(invocation.args).toContain("--allowedTools");
    expect(invocation.args).toContain("--disallowedTools");
    expect(invocation.cwd).toBe(await realpath(directory));
    expect(invocation.prompt).toBe("Perform the fake task without contacting a model.");
  });

  test("returns schema-invalid structured output for service-level validation", async () => {
    const directory = await workspace();
    const driver = new ClaudeCliDriver({ executablePath: claudeFixture, environment: environment("schema-failure") });

    const result = await driver.start(request(directory), async () => {});

    expect(result.structuredOutput).toEqual({ summary: "Invalid", verdict: "unknown", findings: [] });
  });
});
