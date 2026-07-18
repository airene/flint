import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitDiffResponse, GitFileDiffResponse, GitFileStatus, GitFilesResponse, GitStatusResponse } from "@local-pair-review/shared";
import { validateRepositoryRelativePath } from "../utils/path";

const decoder = new TextDecoder();

function command(executable: string, rootPath: string, args: string[], allowNonZero = false): string {
  const result = Bun.spawnSync([executable, ...args], { cwd: rootPath, stdout: "pipe", stderr: "pipe" });
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

interface UntrackedContent {
  binary: boolean;
  snapshotBytes: Uint8Array;
}

export interface SnapshotHashInput {
  baseCommit: string;
  trackedPatch: string;
  stagedPatch: string;
  untracked: ReadonlyArray<{ path: string; snapshotBytes: Uint8Array }>;
}

export function snapshotHashFromInputs(input: SnapshotHashInput): string {
  const untrackedInputs = [...input.untracked].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => (
    `${frame(entry.path)}${frame(createHash("sha256").update(entry.snapshotBytes).digest("hex"))}`
  ));
  return createHash("sha256").update([
    frame(input.baseCommit), frame(input.trackedPatch), frame(input.stagedPatch), ...untrackedInputs,
  ].join("")).digest("hex");
}

async function readUntrackedContent(rootPath: string, path: string): Promise<UntrackedContent> {
  validateRepositoryRelativePath(path);
  const absolutePath = resolve(rootPath, path);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) {
    const target = await readlink(absolutePath);
    return { binary: false, snapshotBytes: new TextEncoder().encode(`symlink:${Buffer.byteLength(target)}:${target}`) };
  }
  if (!metadata.isFile()) {
    return { binary: true, snapshotBytes: new TextEncoder().encode(`special:${metadata.mode}`) };
  }

  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return { binary: hasNul(bytes), snapshotBytes: Buffer.concat([Buffer.from("file:"), bytes]) };
  } finally {
    await handle.close();
  }
}

async function readWorkingTreeText(rootPath: string, path: string): Promise<string | null> {
  validateRepositoryRelativePath(path);
  const absolutePath = resolve(rootPath, path);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) return readlink(absolutePath);
  if (!metadata.isFile()) return null;
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return hasNul(bytes) ? null : decoder.decode(bytes);
  } finally {
    await handle.close();
  }
}

export class GitService {
  constructor(private executable = "git") {}

  setExecutablePath(executable: string): void {
    this.executable = executable;
  }

  async head(rootPath: string): Promise<string> {
    return command(this.executable, rootPath, ["rev-parse", "HEAD"]).trim();
  }

  async status(rootPath: string): Promise<GitStatusResponse> {
    const entries = command(this.executable, rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]).split("\0");
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
        const numstat = command(this.executable, rootPath, ["diff", "--numstat", "HEAD", "--", path], true);
        binary = numstat.startsWith("-\t-");
      } else if (untracked) {
        try { binary = (await readUntrackedContent(rootPath, path)).binary; } catch { binary = true; }
      }
      files.push({ path, previousPath, status: statusKind(x, y), staged: x !== " " && x !== "?", tracked: !untracked, binary });
    }
    const untrackedPaths = command(this.executable, rootPath, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const path of untrackedPaths) {
      let binary = false;
      try { binary = (await readUntrackedContent(rootPath, path)).binary; } catch { binary = true; }
      files.push({ path, previousPath: null, status: "untracked", staged: false, tracked: false, binary });
    }
    return { clean: files.length === 0, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
  }

  async diff(rootPath: string, baseCommit: string): Promise<GitDiffResponse> {
    const status = await this.status(rootPath);
    const untracked = status.files.filter((file) => !file.tracked && !file.binary);
    const untrackedPatch = untracked.map((file) => command(this.executable, rootPath, ["diff", "--no-index", "--", "/dev/null", file.path], true)).join("");
    return {
      baseCommit,
      trackedPatch: command(this.executable, rootPath, ["diff", baseCommit, "--"]),
      stagedPatch: command(this.executable, rootPath, ["diff", "--cached", baseCommit, "--"]),
      untrackedPatch,
      stat: command(this.executable, rootPath, ["diff", "--stat", baseCommit, "--"]),
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
    if (file.binary) return { file, patch: "", originalText: null, modifiedText: null };
    const patch = !file.tracked
      ? command(this.executable, rootPath, ["diff", "--no-index", "--", "/dev/null", path], true)
      : command(this.executable, rootPath, ["diff", baseCommit, "--", path]);
    const originalPath = file.previousPath ?? path;
    const originalText = file.status === "added" || file.status === "untracked"
      ? ""
      : command(this.executable, rootPath, ["show", `${baseCommit}:${originalPath}`], true);
    const modifiedText = file.status === "deleted" ? "" : await readWorkingTreeText(rootPath, path);
    return { file, patch, originalText, modifiedText };
  }

  async snapshotHash(rootPath: string, baseCommit: string): Promise<string> {
    const diff = await this.diff(rootPath, baseCommit);
    const untracked = await Promise.all(diff.files.filter((file) => !file.tracked).map(async (file) => {
      const content = await readUntrackedContent(rootPath, file.path);
      return { path: file.path, snapshotBytes: content.snapshotBytes };
    }));
    return snapshotHashFromInputs({ baseCommit, trackedPatch: diff.trackedPatch, stagedPatch: diff.stagedPatch, untracked });
  }
}

function frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}
