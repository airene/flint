import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentStartRequest } from "@local-pair-review/shared";
import { checkCodexAvailability, checkGitAvailability } from "../../apps/server/src/drivers/cli-availability";
import { resolveCodexModel } from "../../apps/server/src/drivers/cli-model";
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
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: "/definitely/missing/claude-config",
    FAKE_CLI_SCENARIO: scenario,
    ...extra,
  };
}

async function waitForFile(path: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await access(path); return; } catch { await Bun.sleep(5); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe("CLI availability", () => {
  test("reports Codex and Claude subscription authentication when status is clear", async () => {
    const codex = new CodexCliDriver({ executablePath: codexFixture, environment: environment("normal") });
    const claude = new ClaudeCliDriver({ executablePath: claudeFixture, environment: environment("normal") });

    expect(await codex.checkAvailability()).toEqual({
      installed: true,
      executablePath: codexFixture,
      version: "codex-cli 9.9.9-fake",
      authentication: "authenticated",
      model: "gpt-5.6-test",
      modelSource: "user_config",
      reasoningEffort: "high",
      message: null,
    });
    expect(await claude.checkAvailability()).toEqual({
      installed: true,
      executablePath: claudeFixture,
      version: "claude-code 8.8.8-fake",
      authentication: "authenticated",
      model: "default",
      modelSource: "cli_default",
      reasoningEffort: null,
      message: null,
    });
  });

  test("reports Claude model overrides from the inherited environment", async () => {
    const claude = new ClaudeCliDriver({
      executablePath: claudeFixture,
      environment: environment("normal", { ANTHROPIC_MODEL: "opus" }),
    });

    expect(await claude.checkAvailability()).toMatchObject({
      model: "opus",
      modelSource: "environment",
      reasoningEffort: null,
    });
  });

  test("maps real Codex managed origins and ignores project config on the global Settings probe", async () => {
    const directory = await workspace();
    const managed = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("normal", { FAKE_CODEX_MODEL_ORIGIN: "enterpriseManaged" }),
      availabilityWorkingDirectory: directory,
    });
    const global = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("codex-project-config"),
      availabilityWorkingDirectory: directory,
    });
    const unknown = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("normal", { FAKE_CODEX_MODEL_ORIGIN: "futureOrigin" }),
      availabilityWorkingDirectory: directory,
    });

    expect(await managed.checkAvailability()).toMatchObject({
      model: "gpt-5.6-test",
      modelSource: "managed_config",
    });
    expect(await global.checkAvailability()).toMatchObject({ model: "gpt-5.6-test" });
    expect(await unknown.checkAvailability()).toMatchObject({ modelSource: null });
  });

  test("bounds a Codex model probe even when the process ignores SIGTERM", async () => {
    const startedAt = Date.now();
    const result = await resolveCodexModel(
      codexFixture,
      environment("codex-model-probe-hangs"),
      process.cwd(),
      20,
    );

    expect(result).toEqual({ model: null, modelSource: null, reasoningEffort: null });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("bounds version probes when an executable ignores SIGTERM", async () => {
    const startedAt = Date.now();
    const result = await checkCodexAvailability(
      codexFixture,
      environment("availability-probe-hangs"),
      process.cwd(),
      20,
    );

    expect(result.installed).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("terminates a probe descendant after its leader exits", async () => {
    const directory = await workspace();
    const heartbeat = join(directory, "heartbeat");
    const pidLog = join(directory, "child-pid");
    let childPid: number | null = null;
    try {
      await checkCodexAvailability(
        codexFixture,
        environment("availability-probe-leaks-child", {
          FAKE_CLI_HEARTBEAT_LOG: heartbeat,
          FAKE_CLI_CHILD_PID_LOG: pidLog,
        }),
        process.cwd(),
        200,
      );
      await waitForFile(heartbeat);
      childPid = Number(await readFile(pidLog, "utf8"));
      const stoppedAt = await readFile(heartbeat, "utf8");
      await Bun.sleep(80);
      expect(await readFile(heartbeat, "utf8")).toBe(stoppedAt);
    } finally {
      if (childPid) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already stopped */ }
      }
    }
  });

  test("resolves a relative Claude config directory from the availability cwd", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "claude"), { recursive: true });
    await Bun.write(join(directory, "claude/settings.json"), JSON.stringify({ model: "sonnet" }));
    const claude = new ClaudeCliDriver({
      executablePath: claudeFixture,
      environment: environment("normal", { CLAUDE_CONFIG_DIR: "claude" }),
      availabilityWorkingDirectory: directory,
    });

    expect(await claude.checkAvailability()).toMatchObject({
      model: "sonnet",
      modelSource: "user_config",
    });
  });

  test("resolves Claude's default config from the supplied child HOME", async () => {
    const directory = await workspace();
    await mkdir(join(directory, ".claude"), { recursive: true });
    await Bun.write(join(directory, ".claude/settings.json"), JSON.stringify({ model: "opus" }));
    const childEnvironment = environment("normal");
    delete childEnvironment.CLAUDE_CONFIG_DIR;
    childEnvironment.HOME = directory;
    const claude = new ClaudeCliDriver({
      executablePath: claudeFixture,
      environment: childEnvironment,
    });

    expect(await claude.checkAvailability()).toMatchObject({
      model: "opus",
      modelSource: "user_config",
    });
  });

  test("reports explicit Claude unauthenticated state and missing Git", async () => {
    const claude = new ClaudeCliDriver({ executablePath: claudeFixture, environment: environment("unauthenticated") });
    const git = await checkGitAvailability("/definitely/missing/git", environment("normal"));

    const claudeStatus = await claude.checkAvailability();
    expect(claudeStatus.authentication).toBe("unauthenticated");
    expect(claudeStatus.message).toContain("[REDACTED]");
    expect(claudeStatus.message).not.toContain("sk-fake-auth-secret");
    expect(git).toMatchObject({ installed: false, executablePath: "/definitely/missing/git", authentication: "unknown" });
  });

  test("reports clear Codex unauthenticated state and unknown for unsupported auth probe", async () => {
    const unauthenticated = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("codex-unauthenticated"),
    });
    const unsupported = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("codex-auth-unsupported"),
    });

    expect((await unauthenticated.checkAvailability()).authentication).toBe("unauthenticated");
    expect((await unsupported.checkAvailability()).authentication).toBe("unknown");
  });

  test("passes an explicit cwd to every availability probe", async () => {
    const directory = await workspace();
    const probeLog = join(directory, "probes.jsonl");
    const probeEnvironment = environment("normal", { FAKE_CLI_PROBE_LOG: probeLog });
    const codex = new CodexCliDriver({
      executablePath: codexFixture,
      environment: probeEnvironment,
      availabilityWorkingDirectory: directory,
    });
    const claude = new ClaudeCliDriver({
      executablePath: claudeFixture,
      environment: probeEnvironment,
      availabilityWorkingDirectory: directory,
    });

    await codex.checkAvailability();
    await claude.checkAvailability();
    await checkGitAvailability(codexFixture, probeEnvironment, directory);
    const probes = (await readFile(probeLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    expect(probes.map((probe) => probe.args)).toEqual([
      ["--version"],
      ["login", "status"],
      ["app-server", "--listen", "stdio://"],
      ["--version"],
      ["auth", "status"],
      ["--version"],
    ]);
    expect(probes.every((probe) => probe.cwd === directory || probe.cwd === `/private${directory}`)).toBe(true);
  });
});

describe("Codex driver", () => {
  test("the Fake Codex normal scenario rejects resume without workspace-write config", async () => {
    const process = Bun.spawn([
      codexFixture,
      "exec",
      "resume",
      "thread-exact-resume",
      "--json",
      "-",
    ], {
      env: environment("normal"),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });

    expect(await process.exited).toBe(25);
    expect(await new Response(process.stderr).text()).toContain(
      'resume requires -c sandbox_mode="workspace-write"',
    );
  });

  test("the E2E Fake Codex scenario edits only its supplied temporary repository", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "src"));
    const driver = new CodexCliDriver({ executablePath: codexFixture, environment: environment("e2e") });

    await driver.start(request(directory), async () => {});

    expect(await readFile(join(directory, "src", "input.ts"), "utf8")).toContain("E2E Fake Codex");
  });

  test("the E2E Fake Codex scenario rejects feedback that is not an exact-session resume", async () => {
    const directory = await workspace();
    await mkdir(join(directory, "src"));
    const driver = new CodexCliDriver({ executablePath: codexFixture, environment: environment("e2e") });

    await expect(driver.start(request(directory, { prompt: "Fix the selected validation finding." }), async () => {}))
      .rejects.toBeInstanceOf(AgentProcessError);
  });

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
    expect(invocation.args).toEqual([
      "exec",
      "resume",
      "thread-exact-resume",
      "--json",
      "-c",
      'sandbox_mode="workspace-write"',
      "-",
    ]);
    expect(invocation.cwd).toBe(await realpath(directory));
    expect(invocation.prompt).toBe("Perform the fake task without contacting a model.");
  });

  test("continues after invalid and unknown lines and keeps stderr noise out of the event stream", async () => {
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
    expect(stderrEvents.filter((event) => event.type === "stderr")).toHaveLength(0);
    expect(stderrEvents.map((event) => event.type)).toContain("turn_completed");
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

  test("terminates the tracked process group when initial event persistence fails", async () => {
    const directory = await workspace();
    const pidLog = join(directory, "process.pid");
    const heartbeatLog = join(directory, "process.heartbeat");
    const driver = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("pre-stdin-heartbeat", {
        FAKE_CLI_PID_LOG: pidLog,
        FAKE_CLI_HEARTBEAT_LOG: heartbeatLog,
      }),
      cancellationGraceMs: 25,
    });

    const execution = driver.start(request(directory, { runId: "run-emit-failure" }), async () => {
      await waitForFile(pidLog);
      await waitForFile(heartbeatLog);
      throw new Error("event persistence unavailable");
    });
    const settled = execution.then(() => undefined, (error: unknown) => error);
    await waitForFile(pidLog);
    await waitForFile(heartbeatLog);
    const pid = Number(await readFile(pidLog, "utf8"));
    let stoppedHeartbeat = "";

    try {
      expect(await settled).toMatchObject({ message: "event persistence unavailable" });
      await Bun.sleep(25);
      stoppedHeartbeat = await readFile(heartbeatLog, "utf8");
      await Bun.sleep(100);
      expect(await readFile(heartbeatLog, "utf8")).toBe(stoppedHeartbeat);
    } finally {
      const latestHeartbeat = await readFile(heartbeatLog, "utf8").catch(() => "");
      if (stoppedHeartbeat && latestHeartbeat !== stoppedHeartbeat) process.kill(-pid, "SIGKILL");
    }
  });

  test("honors an already-aborted signal without invoking the executable", async () => {
    const directory = await workspace();
    const invocationLog = join(directory, "must-not-exist.json");
    const controller = new AbortController();
    controller.abort();
    const driver = new CodexCliDriver({
      executablePath: codexFixture,
      environment: environment("normal", { FAKE_CLI_INVOCATION_LOG: invocationLog }),
    });

    await expect(driver.start(request(directory, { signal: controller.signal }), async () => {}))
      .rejects.toMatchObject({ kind: "cancelled" });
    expect(await Bun.file(invocationLog).exists()).toBe(false);
  });
});

describe("Claude driver", () => {
  test("the E2E Fake Claude scenario returns its structured finding", async () => {
    const directory = await workspace();
    const driver = new ClaudeCliDriver({ executablePath: claudeFixture, environment: environment("e2e") });

    const result = await driver.start(request(directory), async () => {});

    expect(result.structuredOutput).toMatchObject({ verdict: "changes_suggested", findings: [{ title: "Validate input" }] });
  });

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
