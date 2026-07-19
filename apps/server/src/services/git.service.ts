import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitDiffResponse, GitFileDiffResponse, GitFileStatus, GitFilesResponse, GitStatusResponse } from "@local-pair-review/shared";
import { validateRepositoryRelativePath } from "../utils/path";

const decoder = new TextDecoder();
const UNTRACKED_CONCURRENCY_LIMIT = 4;

async function command(
  executable: string,
  rootPath: string,
  args: string[],
  allowNonZero = false,
  stdin?: Uint8Array,
): Promise<string> {
  const subprocess = Bun.spawn([executable, ...args], {
    cwd: rootPath,
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin ? new Blob([Buffer.from(stdin)]) : "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(subprocess.stdout),
    Bun.readableStreamToText(subprocess.stderr),
    subprocess.exited,
  ]);
  if (exitCode !== 0 && !allowNonZero) throw new Error(`Git ${args[0]} failed: ${stderr.trim()}`);
  return stdout;
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
  patchBytes: Uint8Array | null;
  mode: "100644" | "100755" | "120000" | null;
}

interface UntrackedRead {
  content?: UntrackedContent;
  error?: unknown;
}

interface RepositoryScan {
  status: GitStatusResponse;
  untracked: ReadonlyMap<string, UntrackedRead>;
}

export interface GitCapture {
  status: GitStatusResponse;
  diff: GitDiffResponse;
  snapshotHash: string;
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
    const patchBytes = new TextEncoder().encode(target);
    return {
      binary: false,
      snapshotBytes: new TextEncoder().encode(`symlink:${Buffer.byteLength(target)}:${target}`),
      patchBytes,
      mode: "120000",
    };
  }
  if (!metadata.isFile()) {
    return {
      binary: true,
      snapshotBytes: new TextEncoder().encode(`special:${metadata.mode}`),
      patchBytes: null,
      mode: null,
    };
  }

  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return {
      binary: hasNul(bytes),
      snapshotBytes: Buffer.concat([Buffer.from("file:"), bytes]),
      patchBytes: bytes,
      mode: (metadata.mode & 0o111) === 0 ? "100644" : "100755",
    };
  } finally {
    await handle.close();
  }
}

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function diffPath(prefix: "a" | "b", path: string): string {
  const value = `${prefix}/${path}`;
  return /[\t\n\r"\\]/.test(value) ? JSON.stringify(value) : value;
}

function capturedUntrackedPatch(path: string, content: UntrackedContent, patch: string, objectFormat: "sha1" | "sha256"): string {
  if (!content.patchBytes || !content.mode) return "";
  const oldPath = diffPath("a", path);
  const newPath = diffPath("b", path);
  const newPathTerminator = newPath.startsWith('"') || !path.includes(" ") ? "" : "\t";
  const objectHash = createHash(objectFormat)
    .update(`blob ${content.patchBytes.byteLength}\0`)
    .update(content.patchBytes)
    .digest("hex")
    .slice(0, 7);
  return patch
    .replace("diff --git a/- b/-", `diff --git ${oldPath} ${newPath}`)
    .replace("new file mode 100644\n", `new file mode ${content.mode}\nindex 0000000..${objectHash}\n`)
    .replace("+++ b/-\n", `+++ ${newPath}${newPathTerminator}\n`);
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

function binaryPathsFromNumstat(output: string): Set<string> {
  const binaryPaths = new Set<string>();
  const entries = output.split("\0");
  entries.pop();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    const firstTab = entry.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : entry.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const binary = entry.slice(0, firstTab) === "-" && entry.slice(firstTab + 1, secondTab) === "-";
    const path = entry.slice(secondTab + 1);
    if (path) {
      if (binary) binaryPaths.add(path);
      continue;
    }

    const renamedPath = entries[index + 2];
    index += 2;
    if (binary && renamedPath) binaryPaths.add(renamedPath);
  }
  return binaryPaths;
}

function baseStatusKind(status: string): GitFileStatus["status"] {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "R" || status === "C") return "renamed";
  return "modified";
}

function baseFilesFromNameStatus(output: string, binaryPaths: ReadonlySet<string>): GitFileStatus[] {
  const entries = output.split("\0");
  entries.pop();
  const files: GitFileStatus[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const statusEntry = entries[index] ?? "";
    const status = statusEntry[0];
    if (!status) continue;
    const renamed = status === "R" || status === "C";
    const previousPath = renamed ? entries[++index] ?? null : null;
    const path = entries[++index];
    if (!path) continue;
    const fileStatus = baseStatusKind(status);
    files.push({
      path,
      previousPath,
      status: fileStatus,
      staged: false,
      tracked: true,
      binary: fileStatus !== "deleted" && binaryPaths.has(path),
    });
  }
  return files;
}

function mergeBaseRelativeFiles(baseFiles: readonly GitFileStatus[], currentFiles: readonly GitFileStatus[]): GitFileStatus[] {
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
  const files = baseFiles.map((file) => {
    const current = currentByPath.get(file.path);
    if (!current) return file;
    return {
      ...file,
      staged: current.staged,
      binary: file.status !== "deleted" && (file.binary || current.binary),
    };
  });
  const basePaths = new Set(baseFiles.map((file) => file.path));
  for (const file of currentFiles) {
    if (!basePaths.has(file.path)) files.push(file);
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export class GitService {
  constructor(private executable = "git") {}

  setExecutablePath(executable: string): void {
    this.executable = executable;
  }

  async head(rootPath: string): Promise<string> {
    return (await command(this.executable, rootPath, ["rev-parse", "HEAD"])).trim();
  }

  async status(rootPath: string): Promise<GitStatusResponse> {
    return (await this.scan(rootPath)).status;
  }

  private async scan(rootPath: string): Promise<RepositoryScan> {
    const [statusOutput, untrackedOutput] = await Promise.all([
      command(this.executable, rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]),
      command(this.executable, rootPath, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const entries = statusOutput.split("\0");
    entries.pop();
    const trackedFiles: Array<{ file: Omit<GitFileStatus, "binary">; index: string; worktree: string }> = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const path = entry.slice(3);
      const renamed = x === "R" || y === "R" || x === "C" || y === "C";
      const previousPath = renamed ? entries[++index] ?? null : null;
      const untracked = x === "?" || y === "?";
      trackedFiles.push({
        file: { path, previousPath, status: statusKind(x, y), staged: x !== " " && x !== "?", tracked: !untracked },
        index: x,
        worktree: y,
      });
    }
    const hasTrackedContent = trackedFiles.some(({ index, worktree }) => statusKind(index, worktree) !== "deleted");
    const binaryPaths = hasTrackedContent
      ? binaryPathsFromNumstat(await command(this.executable, rootPath, ["diff", "--numstat", "-z", "HEAD", "--"], true))
      : new Set<string>();
    const files: GitFileStatus[] = trackedFiles.map(({ file }) => ({
      ...file,
      binary: file.status !== "deleted" && binaryPaths.has(file.path),
    }));

    const untrackedPaths = untrackedOutput.split("\0").filter(Boolean);
    const untrackedReads = await mapWithConcurrency(untrackedPaths, UNTRACKED_CONCURRENCY_LIMIT, async (path): Promise<[string, UntrackedRead]> => {
      try {
        return [path, { content: await readUntrackedContent(rootPath, path) }];
      } catch (error) {
        return [path, { error }];
      }
    });
    const untracked = new Map(untrackedReads);
    for (const path of untrackedPaths) {
      const read = untracked.get(path);
      files.push({
        path,
        previousPath: null,
        status: "untracked",
        staged: false,
        tracked: false,
        binary: read?.content?.binary ?? true,
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { status: { clean: files.length === 0, files }, untracked };
  }

  async diff(rootPath: string, baseCommit: string): Promise<GitDiffResponse> {
    return (await this.scanDiff(rootPath, baseCommit)).diff;
  }

  async files(rootPath: string): Promise<GitFilesResponse> {
    return { files: (await this.status(rootPath)).files };
  }

  async fileDiff(rootPath: string, baseCommit: string, path: string): Promise<GitFileDiffResponse> {
    validateRepositoryRelativePath(path);
    const file = (await this.scanDiff(rootPath, baseCommit)).diff.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error("File is not changed in this task");
    if (file.binary) return { file, patch: "", originalText: null, modifiedText: null };
    const patchPromise = !file.tracked
      ? command(this.executable, rootPath, ["diff", "--no-index", "--", "/dev/null", path], true)
      : command(this.executable, rootPath, ["diff", baseCommit, "--", path]);
    const originalPath = file.previousPath ?? path;
    const originalTextPromise = file.status === "added" || file.status === "untracked"
      ? Promise.resolve("")
      : command(this.executable, rootPath, ["show", `${baseCommit}:${originalPath}`], true);
    const modifiedTextPromise = file.status === "deleted" ? Promise.resolve("") : readWorkingTreeText(rootPath, path);
    const [patch, originalText, modifiedText] = await Promise.all([patchPromise, originalTextPromise, modifiedTextPromise]);
    return { file, patch, originalText, modifiedText };
  }

  async snapshotHash(rootPath: string, baseCommit: string): Promise<string> {
    return (await this.capture(rootPath, baseCommit)).snapshotHash;
  }

  async capture(rootPath: string, baseCommit?: string): Promise<GitCapture> {
    const resolvedBaseCommit = baseCommit ?? await this.head(rootPath);
    const { scan, diff } = await this.scanDiff(rootPath, resolvedBaseCommit);
    const untracked = diff.files.filter((file) => !file.tracked).map((file) => {
      const read = scan.untracked.get(file.path);
      if (!read?.content) throw read?.error ?? new Error(`Unable to read untracked file: ${file.path}`);
      return { path: file.path, snapshotBytes: read.content.snapshotBytes };
    });
    return {
      status: scan.status,
      diff,
      snapshotHash: snapshotHashFromInputs({
        baseCommit: resolvedBaseCommit,
        trackedPatch: diff.trackedPatch,
        stagedPatch: diff.stagedPatch,
        untracked,
      }),
    };
  }

  private async scanDiff(rootPath: string, baseCommit: string): Promise<{ scan: RepositoryScan; diff: GitDiffResponse }> {
    const [scan, trackedPatch, stagedPatch, stat, baseNameStatus, baseNumstat, configuredObjectFormat] = await Promise.all([
      this.scan(rootPath),
      command(this.executable, rootPath, ["diff", baseCommit, "--"]),
      command(this.executable, rootPath, ["diff", "--cached", baseCommit, "--"]),
      command(this.executable, rootPath, ["diff", "--stat", baseCommit, "--"]),
      command(this.executable, rootPath, ["diff", "--name-status", "-z", "--find-renames", "--find-copies", baseCommit, "--"]),
      command(this.executable, rootPath, ["diff", "--numstat", "-z", "--find-renames", "--find-copies", baseCommit, "--"]),
      command(this.executable, rootPath, ["config", "--get", "extensions.objectFormat"], true),
    ]);
    const objectFormat = configuredObjectFormat.trim() === "sha256" ? "sha256" : "sha1";
    const untrackedFiles = scan.status.files.filter((file) => !file.tracked && !file.binary);
    const untrackedPatches = await mapWithConcurrency(untrackedFiles, UNTRACKED_CONCURRENCY_LIMIT, async (file) => {
      const read = scan.untracked.get(file.path);
      if (!read?.content?.patchBytes) return "";
      const patch = await command(
        this.executable,
        rootPath,
        ["diff", "--no-index", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--", "/dev/null", "-"],
        true,
        read.content.patchBytes,
      );
      return capturedUntrackedPatch(file.path, read.content, patch, objectFormat);
    });
    const untrackedPatch = untrackedPatches.join("");
    const files = mergeBaseRelativeFiles(baseFilesFromNameStatus(baseNameStatus, binaryPathsFromNumstat(baseNumstat)), scan.status.files);
    const status = { clean: files.length === 0, files };
    return {
      scan: { ...scan, status },
      diff: { baseCommit, trackedPatch, stagedPatch, untrackedPatch, stat, files },
    };
  }
}

function frame(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}
