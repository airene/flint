import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../../apps/server/src/services/git.service";

const directories: string[] = [];
const decoder = new TextDecoder();

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "local-pair-review-git-"));
  directories.push(directory);
  git(directory, "init");
  git(directory, "config", "user.email", "test@example.com");
  git(directory, "config", "user.name", "Test User");
  Bun.write(join(directory, "tracked.txt"), "before\n");
  git(directory, "add", "tracked.txt");
  git(directory, "commit", "-m", "initial");
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(decoder.decode(result.stderr));
  return decoder.decode(result.stdout).trim();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GitService", () => {
  test("reports tracked, staged, untracked, deleted, and binary changes with separate patches", async () => {
    const root = repository();
    const service = new GitService();
    Bun.write(join(root, "deleted.txt"), "delete me\n");
    git(root, "add", "deleted.txt");
    git(root, "commit", "-m", "add deleted fixture");
    const baseCommit = git(root, "rev-parse", "HEAD");
    Bun.write(join(root, "tracked.txt"), "unstaged\n");
    Bun.write(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    Bun.write(join(root, "untracked.txt"), "new\n");
    Bun.write(join(root, "binary.bin"), new Uint8Array([0, 1, 2, 3]));
    git(root, "rm", "deleted.txt");

    const diff = await service.diff(root, baseCommit);
    expect(diff.trackedPatch).toContain("tracked.txt");
    expect(diff.stagedPatch).toContain("staged.txt");
    expect(diff.untrackedPatch).toContain("untracked.txt");
    expect(diff.files.find((file) => file.path === "untracked.txt")).toMatchObject({ status: "untracked", tracked: false, staged: false });
    expect(diff.files.find((file) => file.path === "binary.bin")?.binary).toBe(true);
    expect(diff.files.find((file) => file.path === "deleted.txt")).toMatchObject({ status: "deleted", staged: true });
    expect((await service.files(root)).files).toEqual(diff.files);
  });

  test("returns an empty patch for binary files and creates a stable snapshot independent of file listing order", async () => {
    const root = repository();
    const service = new GitService();
    const baseCommit = git(root, "rev-parse", "HEAD");
    Bun.write(join(root, "b.txt"), "b\n");
    Bun.write(join(root, "a.txt"), "a\n");
    Bun.write(join(root, "image.bin"), new Uint8Array([0, 255, 7]));

    const first = await service.snapshotHash(root, baseCommit);
    const second = await service.snapshotHash(root, baseCommit);
    const binary = await service.fileDiff(root, baseCommit, "image.bin");
    expect(first).toBe(second);
    expect(binary.patch).toBe("");
    Bun.write(join(root, "a.txt"), "changed\n");
    expect(await service.snapshotHash(root, baseCommit)).not.toBe(first);
  });
});
