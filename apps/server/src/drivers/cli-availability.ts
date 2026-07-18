import type { AgentAvailability } from "@local-pair-review/shared";
import { createCliEnvironment } from "../utils/process-environment";
import { redactSensitive } from "../utils/redact";
import { stopProcessTree } from "../utils/process-supervisor";
import { resolveClaudeModel, resolveCodexModel } from "./cli-model";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  args: string[],
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult | undefined> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn(args, {
      cwd,
      env: createCliEnvironment(environment),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });
    const completed = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([exitCode, stdout, stderr]) => ({
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }));
    const timedOut = new Promise<undefined>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
    });
    return await Promise.race([completed, timedOut]);
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child) await stopProcessTree(child);
  }
}

function unavailable(name: string, executablePath: string): AgentAvailability {
  return {
    installed: false,
    executablePath,
    version: null,
    authentication: "unknown",
    model: null,
    modelSource: null,
    reasoningEffort: null,
    message: `${name} CLI is not installed or is not executable.`,
  };
}

export async function checkCodexAvailability(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
  probeTimeoutMs = 2_000,
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment, cwd, probeTimeoutMs);
  if (!version || version.exitCode !== 0) return unavailable("Codex", executablePath);
  const auth = await runCommand([executablePath, "login", "status"], environment, cwd, probeTimeoutMs);
  const authOutput = `${auth?.stdout ?? ""}\n${auth?.stderr ?? ""}`.trim();
  const authentication = /(?:not logged in|unauthenticated)/i.test(authOutput)
    ? "unauthenticated"
    : auth?.exitCode === 0 && /(?:logged in|authenticated)/i.test(authOutput)
      ? "authenticated"
      : "unknown";
  const model = await resolveCodexModel(executablePath, environment, cwd, probeTimeoutMs);
  return {
    installed: true,
    executablePath,
    version: version.stdout || null,
    authentication,
    ...model,
    message: authentication === "authenticated" ? null : redactSensitive(authOutput || "Codex authentication status is unavailable."),
  };
}

export async function checkClaudeAvailability(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
  probeTimeoutMs = 2_000,
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment, cwd, probeTimeoutMs);
  if (!version || version.exitCode !== 0) return unavailable("Claude", executablePath);
  const auth = await runCommand([executablePath, "auth", "status"], environment, cwd, probeTimeoutMs);
  const authenticated = auth?.exitCode === 0;
  const model = await resolveClaudeModel(environment, cwd);
  return {
    installed: true,
    executablePath,
    version: version.stdout || null,
    authentication: authenticated ? "authenticated" : "unauthenticated",
    ...model,
    message: authenticated ? null : redactSensitive(auth?.stderr || "Claude CLI is not authenticated."),
  };
}

export async function checkGitAvailability(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
  probeTimeoutMs = 2_000,
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment, cwd, probeTimeoutMs);
  if (!version || version.exitCode !== 0) return unavailable("Git", executablePath);
  return {
    installed: true,
    executablePath,
    version: version.stdout || null,
    authentication: "unknown",
    model: null,
    modelSource: null,
    reasoningEffort: null,
    message: null,
  };
}
