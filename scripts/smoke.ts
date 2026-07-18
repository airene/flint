import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { checkClaudeAvailability, checkCodexAvailability } from "../apps/server/src/drivers/cli-availability";
import { buildClaudeArgs, buildCodexArgs } from "../apps/server/src/drivers/cli-arguments";
import { createCliEnvironment } from "../apps/server/src/utils/process-environment";
import { redactSensitive } from "../apps/server/src/utils/redact";
import { reviewResultSchema } from "../packages/shared/src";

type Provider = "codex" | "claude";

const provider = process.argv[2] as Provider | undefined;
if (provider !== "codex" && provider !== "claude") {
  throw new Error("Usage: bun run scripts/smoke.ts <codex|claude>");
}

function executable(environmentName: "CODEX_EXECUTABLE" | "CLAUDE_EXECUTABLE", fallback: string): string {
  const configured = process.env[environmentName];
  if (configured && !isAbsolute(configured)) throw new Error(`${environmentName} must be an absolute path when set.`);
  return configured ?? Bun.which(fallback) ?? fallback;
}

async function runGit(repository: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: repository,
    env: createCliEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${redactSensitive(stderr).trim()}`);
}

async function gitOutput(repository: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: repository,
    env: createCliEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${redactSensitive(stderr).trim()}`);
  return stdout;
}

async function repositorySnapshot(repository: string): Promise<string> {
  const [status, diff] = await Promise.all([
    gitOutput(repository, "status", "--porcelain=v1", "--untracked-files=all"),
    gitOutput(repository, "diff", "HEAD", "--"),
  ]);
  return `${status}\n${diff}`;
}

async function runCli(args: string[], repository: string, prompt: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(args, {
    cwd: repository,
    env: createCliEnvironment(process.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(prompt);
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function codexSessionId(output: string): string | null {
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
    } catch { /* Ignore non-JSON diagnostic lines. */ }
  }
  return null;
}

function claudeResult(output: string): { sessionId: string; structuredOutput: unknown } | null {
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: unknown; session_id?: unknown; structured_output?: unknown };
      if (event.type === "result" && typeof event.session_id === "string") {
        return { sessionId: event.session_id, structuredOutput: event.structured_output };
      }
    } catch { /* Ignore non-JSON diagnostic lines. */ }
  }
  return null;
}

async function readConfirmationLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return `${buffered}${decoder.decode()}`.replace(/\r$/, "");
      buffered += decoder.decode(value, { stream: true });
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        await reader.cancel();
        return line;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const repository = await mkdtemp(join(tmpdir(), `flint-${provider}-smoke-`));
try {
  await runGit(repository, "init", "-q");
  await runGit(repository, "config", "user.email", "flint-smoke@example.invalid");
  await runGit(repository, "config", "user.name", "Flint smoke test");
  await Bun.write(join(repository, "README.md"), "# Flint smoke repository\n");
  await runGit(repository, "add", "README.md");
  await runGit(repository, "commit", "-qm", "initial smoke baseline");

  const path = provider === "codex"
    ? executable("CODEX_EXECUTABLE", "codex")
    : executable("CLAUDE_EXECUTABLE", "claude");
  const availability = provider === "codex"
    ? await checkCodexAvailability(path, process.env, repository)
    : await checkClaudeAvailability(path, process.env, repository);

  console.log(`CLI path: ${availability.executablePath ?? path}`);
  console.log(`CLI version: ${availability.version ?? "unavailable"}`);
  console.log(`Authentication mode: ${availability.authentication}`);
  console.log(`Temporary repository: ${repository}`);
  if (!availability.installed || availability.authentication !== "authenticated") {
    console.log("Smoke test stopped: install and sign in to the CLI before authorizing a real subscription run.");
    process.exitCode = 1;
  } else {
    console.log("No subscription command has run. Type RUN and press Enter to authorize this isolated smoke test:");
    const confirmation = await readConfirmationLine();
    if (confirmation !== "RUN") {
      console.log("Smoke test not authorized; no real subscription command was invoked.");
    } else if (provider === "codex") {
      const initial = await runCli(
        buildCodexArgs(path), repository,
        "In this temporary repository only, create SMOKE.md containing the single line 'Codex smoke test'. Do not commit, push, or access the network.",
      );
      console.log(redactSensitive(initial.stdout).trim());
      console.error(redactSensitive(initial.stderr).trim());
      if (initial.exitCode !== 0) throw new Error(`Codex smoke command exited with ${initial.exitCode}.`);
      const sessionId = codexSessionId(initial.stdout);
      if (!sessionId) throw new Error("Codex smoke output did not provide an exact thread ID.");
      if (!(await repositorySnapshot(repository)).trim()) throw new Error("Codex smoke completed without producing a visible Git diff.");
      console.log(`Codex session ID: ${sessionId}`);
      const resumed = await runCli(
        buildCodexArgs(path, sessionId), repository,
        "Confirm the exact-session smoke run completed. Do not make further changes.",
      );
      console.log(redactSensitive(resumed.stdout).trim());
      console.error(redactSensitive(resumed.stderr).trim());
      if (resumed.exitCode !== 0) throw new Error(`Codex exact-session resume exited with ${resumed.exitCode}.`);
    } else {
      const before = await repositorySnapshot(repository);
      const result = await runCli(
        buildClaudeArgs(path), repository,
        "Review this temporary repository without changing files. Return a structured review of the current diff.",
      );
      console.log(redactSensitive(result.stdout).trim());
      console.error(redactSensitive(result.stderr).trim());
      if (result.exitCode !== 0) throw new Error(`Claude smoke command exited with ${result.exitCode}.`);
      const parsed = claudeResult(result.stdout);
      if (!parsed) throw new Error("Claude smoke output did not provide a result event and exact session ID.");
      const structured = reviewResultSchema.safeParse(parsed.structuredOutput);
      if (!structured.success) throw new Error("Claude smoke structured output did not match the review schema.");
      const after = await repositorySnapshot(repository);
      if (after !== before) throw new Error("Claude smoke changed the repository despite read-only review permissions.");
      console.log(`Claude session ID: ${parsed.sessionId}`);
      console.log(`Claude review verdict: ${structured.data.verdict}; findings: ${structured.data.findings.length}`);
    }
  }
} finally {
  await rm(repository, { recursive: true, force: true });
}
