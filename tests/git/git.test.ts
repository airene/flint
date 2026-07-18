import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService, snapshotHashFromInputs } from "../../apps/server/src/services/git.service";

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
  test("enumerates every nested untracked file instead of collapsing its directory", async () => {
    const root = repository();
    const service = new GitService();
    mkdirSync(join(root, "nested", "deep"), { recursive: true });
    await Bun.write(join(root, "nested", "one.txt"), "one\n");
    await Bun.write(join(root, "nested", "deep", "two.txt"), "two\n");

    const paths = (await service.status(root)).files.map((file) => file.path);

    expect(paths).toContain("nested/one.txt");
    expect(paths).toContain("nested/deep/two.txt");
    expect(paths).not.toContain("nested/");
  });

  test("hashes an untracked symlink as a link without reading its external target", async () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "local-pair-review-outside-"));
    directories.push(outside);
    const outsideFile = join(outside, "secret.txt");
    await Bun.write(outsideFile, "outside secret one\n");
    symlinkSync(outsideFile, join(root, "external-link"));
    const service = new GitService();
    const baseCommit = git(root, "rev-parse", "HEAD");

    const first = await service.snapshotHash(root, baseCommit);
    await Bun.write(outsideFile, "outside secret two\n");
    const second = await service.snapshotHash(root, baseCommit);

    expect(second).toBe(first);
    expect((await service.diff(root, baseCommit)).untrackedPatch).not.toContain("outside secret");
  });

  test("per-file diff includes working-tree changes for mixed MM and AM states", async () => {
    const root = repository();
    const service = new GitService();
    const baseCommit = git(root, "rev-parse", "HEAD");
    await Bun.write(join(root, "tracked.txt"), "staged tracked\n");
    git(root, "add", "tracked.txt");
    await Bun.write(join(root, "tracked.txt"), "working tracked\n");
    await Bun.write(join(root, "added.txt"), "staged added\n");
    git(root, "add", "added.txt");
    await Bun.write(join(root, "added.txt"), "staged added\nworking added\n");

    const modifiedPatch = (await service.fileDiff(root, baseCommit, "tracked.txt")).patch;
    const addedPatch = (await service.fileDiff(root, baseCommit, "added.txt")).patch;

    expect(modifiedPatch).toContain("working tracked");
    expect(addedPatch).toContain("working added");
  });

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

  test("returns an empty binary patch and hashes identical snapshot inputs independently of enumeration order", async () => {
    const root = repository();
    const service = new GitService();
    const baseCommit = git(root, "rev-parse", "HEAD");
    Bun.write(join(root, "b.txt"), "b\n");
    Bun.write(join(root, "a.txt"), "a\n");
    Bun.write(join(root, "image.bin"), new Uint8Array([0, 255, 7]));

    const first = await service.snapshotHash(root, baseCommit);
    const binary = await service.fileDiff(root, baseCommit, "image.bin");
    expect(binary.patch).toBe("");

    const parts = await service.diff(root, baseCommit);
    const untracked = await Promise.all(["a.txt", "b.txt", "image.bin"].map(async (path) => ({
      path,
      snapshotBytes: Buffer.concat([Buffer.from("file:"), Buffer.from(await Bun.file(join(root, path)).arrayBuffer())]),
    })));
    const forward = snapshotHashFromInputs({ baseCommit, trackedPatch: parts.trackedPatch, stagedPatch: parts.stagedPatch, untracked });
    const reversed = snapshotHashFromInputs({ baseCommit, trackedPatch: parts.trackedPatch, stagedPatch: parts.stagedPatch, untracked: [...untracked].reverse() });
    expect(forward).toBe(reversed);
    expect(first).toBe(forward);

    Bun.write(join(root, "a.txt"), "changed\n");
    expect(await service.snapshotHash(root, baseCommit)).not.toBe(first);
  });
});
