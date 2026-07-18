import type { AgentAvailability } from "@local-pair-review/shared";
import { createCliEnvironment } from "../utils/process-environment";
import { redactSensitive } from "../utils/redact";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(
  args: string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CommandResult | undefined> {
  try {
    const child = Bun.spawn(args, {
      env: createCliEnvironment(environment),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return undefined;
  }
}

function unavailable(name: string): AgentAvailability {
  return {
    installed: false,
    executablePath: null,
    version: null,
    authentication: "unknown",
    message: `${name} CLI is not installed or is not executable.`,
  };
}

export async function checkCodexAvailability(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment);
  if (!version || version.exitCode !== 0) return unavailable("Codex");
  return {
    installed: true,
    executablePath,
    version: version.stdout || null,
    authentication: "unknown",
    message: null,
  };
}

export async function checkClaudeAvailability(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment);
  if (!version || version.exitCode !== 0) return unavailable("Claude");
  const auth = await runCommand([executablePath, "auth", "status"], environment);
  const authenticated = auth?.exitCode === 0;
  return {
    installed: true,
    executablePath,
    version: version.stdout || null,
    authentication: authenticated ? "authenticated" : "unauthenticated",
    message: authenticated ? null : redactSensitive(auth?.stderr || "Claude CLI is not authenticated."),
  };
}

export async function checkGitAvailability(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment);
  if (!version || version.exitCode !== 0) return unavailable("Git");
  return {
    installed: true,
    executablePath,
    version: version.stdout || null,
    authentication: "unknown",
    message: null,
  };
}
