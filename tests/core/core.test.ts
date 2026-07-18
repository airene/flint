import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../../apps/server/src/db/database";
import { ProjectService, ConfirmationRequiredError, DuplicateProjectError } from "../../apps/server/src/services/project.service";
import { TaskService, DirtyWorkingTreeError, InvalidTaskTransitionError } from "../../apps/server/src/services/task.service";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "local-pair-review-core-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function repository(): string {
  const directory = temporaryDirectory();
  git(directory, "init");
  git(directory, "config", "user.email", "test@example.com");
  git(directory, "config", "user.name", "Test User");
  Bun.write(join(directory, "README.md"), "initial\n");
  git(directory, "add", "README.md");
  git(directory, "commit", "-m", "initial");
  return directory;
}

function services() {
  const database = createDatabase(join(temporaryDirectory(), "app.db"));
  return {
    database,
    projects: new ProjectService(database),
    tasks: new TaskService(database),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("projects", () => {
  test("canonicalizes a repository subdirectory and prevents duplicate registration", async () => {
    const root = repository();
    const nested = join(root, "nested");
    mkdirSync(nested);
    const { projects } = services();

    const project = await projects.add(nested);
    expect(project.rootPath).toBe(realpathSync(root));
    await expect(projects.add(root)).rejects.toBeInstanceOf(DuplicateProjectError);
  });

  test("requires confirmation before deleting historical application data and never removes the repository", async () => {
    const root = repository();
    const { projects, tasks } = services();
    const project = await projects.add(root);
    await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });

    await expect(projects.remove(project.id)).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect((await projects.removalInfo(project.id)).taskCount).toBe(1);
    await projects.remove(project.id, true);
    expect(await Bun.file(join(root, ".git", "HEAD")).exists()).toBe(true);
    expect(await projects.get(project.id)).toBeNull();
  });

  test("never cascade-deletes a task inserted while unconfirmed project removal is deciding", async () => {
    const root = repository();
    const databasePath = join(temporaryDirectory(), "concurrent.db");
    const primary = createDatabase(databasePath);
    const concurrent = createDatabase(databasePath);
    const projects = new ProjectService(primary);
    const project = await projects.add(root);

    try {
      const removal = projects.remove(project.id);
      await Promise.resolve();
      await Promise.resolve();

      let insertionError: unknown;
      let inserted = false;
      try {
        concurrent.sqlite.run(
          "insert into tasks (id, project_id, title, original_prompt, working_directory, base_commit, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
          ["concurrent_task", project.id, "Concurrent", "Prompt", realpathSync(root), git(root, "rev-parse", "HEAD"), new Date().toISOString(), new Date().toISOString()],
        );
        inserted = true;
      } catch (error) {
        insertionError = error;
      }

      if (inserted) {
        await expect(removal).rejects.toBeInstanceOf(ConfirmationRequiredError);
        expect(concurrent.sqlite.query("select count(*) as count from tasks where id = 'concurrent_task'").get()).toEqual({ count: 1 });
      } else {
        await removal;
        expect(String(insertionError)).toContain("FOREIGN KEY");
      }
    } finally {
      primary.close();
      concurrent.close();
    }
  });
});

describe("tasks", () => {
  test("requires explicit acknowledgement of a dirty working tree", async () => {
    const root = repository();
    Bun.write(join(root, "README.md"), "changed\n");
    const { projects, tasks } = services();
    const project = await projects.add(root);

    await expect(tasks.create(project.id, { title: "Task", originalPrompt: "Do work" })).rejects.toBeInstanceOf(DirtyWorkingTreeError);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work", confirmDirtyWorkingTree: true });
    expect(task.baseCommit).toBe(git(root, "rev-parse", "HEAD"));
    expect(task.workingDirectory).toBe(realpathSync(root));
  });

  test("enforces workflow transitions and returns failed developer work to a recoverable state", async () => {
    const root = repository();
    const { projects, tasks } = services();
    const project = await projects.add(root);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });

    await expect(tasks.transition(task.id, "reviewing")).rejects.toBeInstanceOf(InvalidTaskTransitionError);
    await tasks.transition(task.id, "developing");
    expect((await tasks.fallbackAfterRun(task.id, "developer_initial", { hasSessionId: false, workingTreeChanged: false })).status).toBe("draft");
    await tasks.transition(task.id, "developing");
    expect((await tasks.fallbackAfterRun(task.id, "developer_initial", { hasSessionId: true, workingTreeChanged: false })).status).toBe("ready_for_review");
  });

  test("keeps a successfully finished but unparsable review available for human action", async () => {
    const root = repository();
    const { projects, tasks } = services();
    const project = await projects.add(root);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });
    await tasks.transition(task.id, "developing");
    await tasks.transition(task.id, "ready_for_review");
    await tasks.transition(task.id, "reviewing");

    expect((await tasks.fallbackAfterRun(task.id, "reviewer", { reviewParseFailed: true })).status).toBe("waiting_for_human");
  });

  test("rejects a stale transition instead of overwriting a concurrent status change", async () => {
    const root = repository();
    const { database, projects, tasks } = services();
    const project = await projects.add(root);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });

    const transition = tasks.transition(task.id, "developing");
    database.sqlite.run("update tasks set status = 'completed' where id = ?", [task.id]);

    await expect(transition).rejects.toThrow("Task status changed concurrently");
    expect((await tasks.get(task.id))?.status).toBe("completed");
  });

  test("finds an active project write run without mocking the database", async () => {
    const root = repository();
    const { database, projects, tasks } = services();
    const project = await projects.add(root);
    const task = await tasks.create(project.id, { title: "Task", originalPrompt: "Do work" });
    database.sqlite.run(`insert into agent_runs (id, task_id, project_id, provider, run_type, status, prompt) values (?, ?, ?, 'codex', 'developer_initial', 'queued', 'x')`, ["run_1", task.id, project.id]);

    expect(await tasks.hasActiveProjectWriteRun(project.id)).toBe(true);
  });
});
