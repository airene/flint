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
  cwd: string,
): Promise<CommandResult | undefined> {
  try {
    const child = Bun.spawn(args, {
      cwd,
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

function unavailable(name: string, executablePath: string): AgentAvailability {
  return {
    installed: false,
    executablePath,
    version: null,
    authentication: "unknown",
    message: `${name} CLI is not installed or is not executable.`,
  };
}

export async function checkCodexAvailability(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment, cwd);
  if (!version || version.exitCode !== 0) return unavailable("Codex", executablePath);
  const auth = await runCommand([executablePath, "login", "status"], environment, cwd);
  const authOutput = `${auth?.stdout ?? ""}\n${auth?.stderr ?? ""}`.trim();
  const authentication = /(?:not logged in|unauthenticated)/i.test(authOutput)
    ? "unauthenticated"
    : auth?.exitCode === 0 && /(?:logged in|authenticated)/i.test(authOutput)
      ? "authenticated"
      : "unknown";
  return {
    installed: true,
    executablePath,
    version: version.stdout || null,
    authentication,
    message: authentication === "authenticated" ? null : redactSensitive(authOutput || "Codex authentication status is unavailable."),
  };
}

export async function checkClaudeAvailability(
  executablePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  cwd = process.cwd(),
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment, cwd);
  if (!version || version.exitCode !== 0) return unavailable("Claude", executablePath);
  const auth = await runCommand([executablePath, "auth", "status"], environment, cwd);
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
  cwd = process.cwd(),
): Promise<AgentAvailability> {
  const version = await runCommand([executablePath, "--version"], environment, cwd);
  if (!version || version.exitCode !== 0) return unavailable("Git", executablePath);
  return {
    installed: true,
    executablePath,
    version: version.stdout || null,
    authentication: "unknown",
    message: null,
  };
}
