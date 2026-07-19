import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface InstrumentedGitOptions {
  noIndexDelaySeconds?: number;
  mutateOnNoIndex?: { path: string; content: string };
}

async function instrumentedGit(options: InstrumentedGitOptions = {}): Promise<{
  executable: string;
  invocations: () => string[];
  events: () => string[];
}> {
  const directory = mkdtempSync(join(tmpdir(), "local-pair-review-git-instrumentation-"));
  directories.push(directory);
  const executable = join(directory, "git");
  const log = join(directory, "invocations.log");
  const eventLog = join(directory, "events.log");
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git executable is required for this test");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' \"$*\" >> ${shellQuote(log)}`,
    'if [ "$1" = "diff" ] && [ "$2" = "--no-index" ]; then',
    `  printf 'start %s\\n' \"$$\" >> ${shellQuote(eventLog)}`,
  ];
  if (options.mutateOnNoIndex) {
    script.push(`  printf '%s' ${shellQuote(options.mutateOnNoIndex.content)} > ${shellQuote(options.mutateOnNoIndex.path)}`);
  }
  if (options.noIndexDelaySeconds) script.push(`  sleep ${options.noIndexDelaySeconds}`);
  script.push(
    `  ${shellQuote(realGit)} \"$@\"`,
    "  git_exit=$?",
    `  printf 'end %s\\n' \"$$\" >> ${shellQuote(eventLog)}`,
    "  exit $git_exit",
    "fi",
    `exec ${shellQuote(realGit)} \"$@\"`,
    "",
  );
  await Bun.write(executable, script.join("\n"));
  chmodSync(executable, 0o755);
  const lines = (path: string): string[] => existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return {
    executable,
    invocations: () => lines(log),
    events: () => lines(eventLog),
  };
}

function maximumConcurrentEvents(events: string[]): number {
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    if (event.startsWith("start ")) {
      active += 1;
      maximum = Math.max(maximum, active);
    } else if (event.startsWith("end ")) {
      active -= 1;
    }
  }
  expect(active).toBe(0);
  return maximum;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GitService", () => {
  test("lists safe tracked and untracked project files with ranked capped in-memory search and a five-second cache", async () => {
    const root = repository();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "target"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    mkdirSync(join(root, "xsrc"), { recursive: true });
    await Bun.write(join(root, "target.ts"), "target\n");
    await Bun.write(join(root, "src", "target-helper.ts"), "helper\n");
    await Bun.write(join(root, "target", "deep.ts"), "deep\n");
    await Bun.write(join(root, "docs", "my-target.md"), "substring\n");
    await Bun.write(join(root, "xsrc", "target.ts"), "substring\n");
    await Bun.write(join(root, "untracked.txt"), "untracked\n");
    await Bun.write(join(root, "ignored.txt"), "ignored\n");
    await Bun.write(join(root, "unsafe\nname.txt"), "unsafe\n");
    await Bun.write(join(root, ".gitignore"), "ignored.txt\n");
    git(root, "add", "target.ts", "src/target-helper.ts", ".gitignore");
    const instrumentation = await instrumentedGit();
    let now = 1_000;
    const service = new GitService(instrumentation.executable, () => now);

    const all = await service.projectFiles("project-1", root, "", 50);
    const ranked = await service.projectFiles("project-1", root, "TARGET", 50);
    const limited = await service.projectFiles("project-1", root, "target", 2);
    const nestedQuery = await service.projectFiles("project-1", root, "src/target", 50);

    expect(all.files).toContain("tracked.txt");
    expect(all.files).toContain("untracked.txt");
    expect(all.files).not.toContain("ignored.txt");
    expect(all.files).not.toContain("unsafe\nname.txt");
    expect(ranked.files).toEqual([
      "target.ts",
      "xsrc/target.ts",
      "src/target-helper.ts",
      "target/deep.ts",
      "docs/my-target.md",
    ]);
    expect(limited.files).toEqual(ranked.files.slice(0, 2));
    expect(nestedQuery.files).toEqual(["src/target-helper.ts", "xsrc/target.ts"]);
    expect(instrumentation.invocations()).toEqual([
      "ls-files --cached --others --exclude-standard -z",
    ]);

    await service.projectFiles("project-2", root, "target", 50);
    expect(instrumentation.invocations()).toHaveLength(2);

    now += 5_001;
    await service.projectFiles("project-1", root, "query-is-not-a-git-argument", 50);
    expect(instrumentation.invocations()).toEqual([
      "ls-files --cached --others --exclude-standard -z",
      "ls-files --cached --others --exclude-standard -z",
      "ls-files --cached --others --exclude-standard -z",
    ]);
  });

  test("does not block the event loop while a Git command is running", async () => {
    const root = repository();
    const directory = mkdtempSync(join(tmpdir(), "local-pair-review-slow-git-"));
    directories.push(directory);
    const executable = join(directory, "git");
    await Bun.write(executable, "#!/bin/sh\nsleep 0.1\nprintf 'fake-head\\n'\n");
    chmodSync(executable, 0o755);
    const service = new GitService(executable);
    let timerRan = false;
    const timer = new Promise<void>((resolve) => setTimeout(() => {
      timerRan = true;
      resolve();
    }, 20));

    expect(await service.head(root)).toBe("fake-head");
    expect(timerRan).toBe(true);
    await timer;
  });

  test("uses one batched numstat command for all tracked changes", async () => {
    const root = repository();
    await Bun.write(join(root, "second.txt"), "second before\n");
    await Bun.write(join(root, "third.txt"), "third before\n");
    git(root, "add", "second.txt", "third.txt");
    git(root, "commit", "-m", "add tracked fixtures");
    await Bun.write(join(root, "tracked.txt"), "tracked after\n");
    await Bun.write(join(root, "second.txt"), "second after\n");
    await Bun.write(join(root, "third.txt"), "third after\n");
    const instrumentation = await instrumentedGit();
    const service = new GitService(instrumentation.executable);

    const status = await service.status(root);

    expect(status.files).toHaveLength(3);
    expect(instrumentation.invocations().filter((entry) => entry.startsWith("diff --numstat"))).toHaveLength(1);
  });

  test("capture builds status, diff, and snapshot hash from one repository scan", async () => {
    const root = repository();
    const baseCommit = git(root, "rev-parse", "HEAD");
    await Bun.write(join(root, "tracked.txt"), "tracked after\n");
    await Bun.write(join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    await Bun.write(join(root, "untracked.txt"), "untracked\n");
    const instrumentation = await instrumentedGit();
    const service = new GitService(instrumentation.executable);

    const capture = await service.capture(root);

    expect(capture.status.files).toEqual(capture.diff.files);
    expect(capture.diff).toMatchObject({ baseCommit });
    expect(capture.diff.trackedPatch).toContain("tracked.txt");
    expect(capture.diff.stagedPatch).toContain("staged.txt");
    expect(capture.diff.untrackedPatch).toContain("untracked.txt");
    expect(capture.snapshotHash).toHaveLength(64);
    const invocations = instrumentation.invocations();
    expect(invocations.filter((entry) => entry.startsWith("status --porcelain"))).toHaveLength(1);
    expect(invocations.filter((entry) => entry.startsWith("ls-files --others"))).toHaveLength(1);
    expect(invocations.filter((entry) => entry.startsWith("diff --numstat"))).toHaveLength(2);
    expect(invocations.filter((entry) => entry === "rev-parse HEAD")).toHaveLength(1);
    expect(invocations.filter((entry) => entry === `diff ${baseCommit} --`)).toHaveLength(1);
    expect(invocations.filter((entry) => entry === `diff --cached ${baseCommit} --`)).toHaveLength(1);
    expect(invocations.filter((entry) => entry === `diff --stat ${baseCommit} --`)).toHaveLength(1);
  });

  test("captures committed changes after the task base in the task-scoped status and per-file diff", async () => {
    const root = repository();
    const service = new GitService();
    const baseCommit = git(root, "rev-parse", "HEAD");
    await Bun.write(join(root, "tracked.txt"), "committed after base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "change after task base");

    const capture = await service.capture(root, baseCommit);
    const file = await service.fileDiff(root, baseCommit, "tracked.txt");

    expect(capture.status).toMatchObject({ clean: false });
    expect(capture.status.files).toEqual(capture.diff.files);
    expect(capture.status.files).toContainEqual(expect.objectContaining({
      path: "tracked.txt",
      status: "modified",
      staged: false,
      tracked: true,
    }));
    expect(capture.diff.trackedPatch).toContain("committed after base");
    expect(file).toMatchObject({
      file: expect.objectContaining({ path: "tracked.txt", status: "modified" }),
      originalText: "before\n",
      modifiedText: "committed after base\n",
    });
    expect(file.patch).toContain("committed after base");
  });

  test("merges committed and current working-tree changes from the task base without duplicate paths", async () => {
    const root = repository();
    const service = new GitService();
    await Bun.write(join(root, "second.txt"), "second before\n");
    git(root, "add", "second.txt");
    git(root, "commit", "-m", "add second fixture");
    const baseCommit = git(root, "rev-parse", "HEAD");
    await Bun.write(join(root, "tracked.txt"), "committed after base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "change after task base");
    await Bun.write(join(root, "second.txt"), "working after base\n");

    const capture = await service.capture(root, baseCommit);

    expect(capture.status.files.map((file) => file.path)).toEqual(["second.txt", "tracked.txt"]);
    expect(capture.status.files.find((file) => file.path === "tracked.txt")).toMatchObject({ staged: false, status: "modified" });
    expect(capture.status.files.find((file) => file.path === "second.txt")).toMatchObject({ staged: false, status: "modified" });
    expect(capture.diff.trackedPatch).toContain("committed after base");
    expect(capture.diff.trackedPatch).toContain("working after base");
  });

  test("rejects an unreachable base commit consistently across task-scoped Git operations", async () => {
    const root = repository();
    const service = new GitService();
    await Bun.write(join(root, "tracked.txt"), "working change\n");

    await expect(service.capture(root, "does-not-exist")).rejects.toThrow("Git diff failed");
    await expect(service.fileDiff(root, "does-not-exist", "tracked.txt")).rejects.toThrow("Git diff failed");
  });

  test("limits concurrent untracked diff work", async () => {
    const root = repository();
    const baseCommit = git(root, "rev-parse", "HEAD");
    for (let index = 0; index < 12; index += 1) {
      await Bun.write(join(root, `untracked-${index}.txt`), `${index}\n`);
    }
    const instrumentation = await instrumentedGit({ noIndexDelaySeconds: 0.1 });
    const service = new GitService(instrumentation.executable);

    await service.diff(root, baseCommit);

    expect(instrumentation.invocations().filter((entry) => entry.startsWith("diff --no-index"))).toHaveLength(12);
    expect(maximumConcurrentEvents(instrumentation.events())).toBeLessThanOrEqual(4);
  });

  test("capture derives untracked patch and hash from the same scanned bytes", async () => {
    const root = repository();
    const baseCommit = git(root, "rev-parse", "HEAD");
    const untrackedPath = join(root, "untracked.txt");
    await Bun.write(untrackedPath, "captured before\n");
    const instrumentation = await instrumentedGit({
      mutateOnNoIndex: { path: untrackedPath, content: "changed after scan\n" },
    });
    const service = new GitService(instrumentation.executable);

    const capture = await service.capture(root, baseCommit);

    expect(await Bun.file(untrackedPath).text()).toBe("changed after scan\n");
    expect(capture.diff.untrackedPatch).toContain("captured before");
    expect(capture.diff.untrackedPatch).not.toContain("changed after scan");
    expect(capture.snapshotHash).toBe(snapshotHashFromInputs({
      baseCommit,
      trackedPatch: capture.diff.trackedPatch,
      stagedPatch: capture.diff.stagedPatch,
      untracked: [{
        path: "untracked.txt",
        snapshotBytes: Buffer.from("file:captured before\n"),
      }],
    }));
  });

  test("aggregate untracked patch has stable unique paths when diff.noprefix is configured", async () => {
    const root = repository();
    const baseCommit = git(root, "rev-parse", "HEAD");
    git(root, "config", "diff.noprefix", "true");
    const firstPath = join(root, "first.txt");
    const spacedPath = join(root, "space name.txt");
    await Bun.write(firstPath, "first\n");
    await Bun.write(spacedPath, "spaced\n");
    const service = new GitService();

    const patch = (await service.capture(root, baseCommit)).diff.untrackedPatch;

    expect(patch).toContain("a/first.txt");
    expect(patch).toContain("b/first.txt");
    expect(patch).toContain("a/space name.txt");
    expect(patch).toContain("b/space name.txt");
    expect(patch.match(/diff --git /g)).toHaveLength(2);
    rmSync(firstPath);
    rmSync(spacedPath);
    const patchDirectory = mkdtempSync(join(tmpdir(), "local-pair-review-patch-"));
    directories.push(patchDirectory);
    const patchPath = join(patchDirectory, "untracked.patch");
    await Bun.write(patchPath, patch);
    expect(() => git(root, "apply", "--check", patchPath)).not.toThrow();
  });

  test("batch numstat maps rename and copy records to their binary destination paths", async () => {
    const root = repository();
    const directory = mkdtempSync(join(tmpdir(), "local-pair-review-numstat-git-"));
    directories.push(directory);
    const executable = join(directory, "git");
    await Bun.write(executable, [
      "#!/bin/sh",
      'if [ "$1" = "status" ]; then',
      "  printf 'R  renamed.bin\\000old.bin\\000C  copy.bin\\000source.bin\\000 M tracked.bin\\000'",
      "elif [ \"$1\" = \"ls-files\" ]; then",
      "  exit 0",
      "elif [ \"$1\" = \"diff\" ] && [ \"$2\" = \"--numstat\" ]; then",
      "  printf -- '-\\t-\\t\\000old.bin\\000renamed.bin\\000-\\t-\\t\\000source.bin\\000copy.bin\\000-\\t-\\ttracked.bin\\000'",
      "fi",
      "",
    ].join("\n"));
    chmodSync(executable, 0o755);
    const service = new GitService(executable);

    const status = await service.status(root);

    expect(status.files.find((file) => file.path === "renamed.bin")).toMatchObject({
      previousPath: "old.bin",
      status: "renamed",
      binary: true,
    });
    expect(status.files.find((file) => file.path === "copy.bin")).toMatchObject({
      previousPath: "source.bin",
      status: "renamed",
      binary: true,
    });
    expect(status.files.find((file) => file.path === "tracked.bin")?.binary).toBe(true);
  });

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

    const modified = await service.fileDiff(root, baseCommit, "tracked.txt");
    const added = await service.fileDiff(root, baseCommit, "added.txt");
    const modifiedPatch = modified.patch;
    const addedPatch = added.patch;

    expect(modifiedPatch).toContain("working tracked");
    expect(addedPatch).toContain("working added");
    expect(modified).toMatchObject({ originalText: "before\n", modifiedText: "working tracked\n" });
    expect(added).toMatchObject({ originalText: "", modifiedText: "staged added\nworking added\n" });
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
    expect(binary).toMatchObject({ patch: "", originalText: null, modifiedText: null });

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
