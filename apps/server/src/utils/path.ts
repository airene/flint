import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export class GitRootValidationError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "GitRootValidationError";
  }
}

export async function canonicalGitRoot(path: string): Promise<string> {
  let directory: string;
  try {
    directory = await realpath(resolve(path));
  } catch (cause) {
    throw new GitRootValidationError("Project path does not exist or cannot be resolved", cause);
  }

  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new GitRootValidationError("Project path is not inside a Git repository");

  try {
    return await realpath(new TextDecoder().decode(result.stdout).trim());
  } catch (cause) {
    throw new GitRootValidationError("Git repository root cannot be resolved", cause);
  }
}

export function validateRepositoryRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new GitRootValidationError("File path must be relative to the project root");
  }
}
