import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitDiffResponse, GitFileDiffResponse, GitFileStatus, GitFilesResponse, GitStatusResponse } from "@local-pair-review/shared";
import { validateRepositoryRelativePath } from "../utils/path";

const decoder = new TextDecoder();

function command(rootPath: string, args: string[], allowNonZero = false): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: rootPath, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 && !allowNonZero) throw new Error(`Git ${args[0]} failed: ${decoder.decode(result.stderr).trim()}`);
  return decoder.decode(result.stdout);
}

function statusKind(index: string, worktree: string): GitFileStatus["status"] {
  if (index === "?" || worktree === "?") return "untracked";
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "R" || worktree === "R" || index === "C" || worktree === "C") return "renamed";
  if (index === "A" || worktree === "A") return "added";
  return "modified";
}

function hasNul(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

export class GitService {
  async status(rootPath: string): Promise<GitStatusResponse> {
    const entries = command(rootPath, ["status", "--porcelain=v1", "-z"]).split("\0");
    entries.pop();
    const files: GitFileStatus[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const path = entry.slice(3);
      const renamed = x === "R" || y === "R" || x === "C" || y === "C";
      const previousPath = renamed ? entries[++index] ?? null : null;
      const untracked = x === "?" || y === "?";
      let binary = false;
      if (!untracked && statusKind(x, y) !== "deleted") {
        const numstat = command(rootPath, ["diff", "--numstat", "HEAD", "--", path], true);
        binary = numstat.startsWith("-\t-");
      } else if (untracked) {
        try { binary = hasNul(await readFile(resolve(rootPath, path))); } catch { binary = false; }
      }
      files.push({ path, previousPath, status: statusKind(x, y), staged: x !== " " && x !== "?", tracked: !untracked, binary });
    }
    return { clean: files.length === 0, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  async diff(rootPath: string, baseCommit: string): Promise<GitDiffResponse> {
    const status = await this.status(rootPath);
    const untracked = status.files.filter((file) => !file.tracked && !file.binary);
    const untrackedPatch = untracked.map((file) => command(rootPath, ["diff", "--no-index", "--", "/dev/null", file.path], true)).join("");
    return {
      baseCommit,
      trackedPatch: command(rootPath, ["diff", baseCommit, "--"]),
      stagedPatch: command(rootPath, ["diff", "--cached", baseCommit, "--"]),
      untrackedPatch,
      stat: command(rootPath, ["diff", "--stat", baseCommit, "--"]),
      files: status.files,
    };
  }

  async files(rootPath: string): Promise<GitFilesResponse> {
    return { files: (await this.status(rootPath)).files };
  }

  async fileDiff(rootPath: string, baseCommit: string, path: string): Promise<GitFileDiffResponse> {
    validateRepositoryRelativePath(path);
    const file = (await this.status(rootPath)).files.find((candidate) => candidate.path === path);
    if (!file) throw new Error("File is not changed in this task");
    if (file.binary) return { file, patch: "" };
    const patch = !file.tracked
      ? command(rootPath, ["diff", "--no-index", "--", "/dev/null", path], true)
      : file.staged
        ? command(rootPath, ["diff", "--cached", baseCommit, "--", path])
        : command(rootPath, ["diff", baseCommit, "--", path]);
    return { file, patch };
  }

  async snapshotHash(rootPath: string, baseCommit: string): Promise<string> {
    const diff = await this.diff(rootPath, baseCommit);
    const untrackedInputs = await Promise.all(diff.files.filter((file) => !file.tracked).sort((a, b) => a.path.localeCompare(b.path)).map(async (file) => {
      const bytes = await readFile(resolve(rootPath, file.path));
      return `${frame(file.path)}${frame(createHash("sha256").update(bytes).digest("hex"))}`;
    }));
    return createHash("sha256").update([
      frame(baseCommit), frame(diff.trackedPatch), frame(diff.stagedPatch), ...untrackedInputs,
    ].join("")).digest("hex");
  }
}

function frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}
