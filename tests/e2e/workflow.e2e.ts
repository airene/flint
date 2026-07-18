import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// The .e2e.ts suffix keeps Bun's unit-test discovery from loading Playwright hooks.
const repositories: string[] = [];
const execute = promisify(execFile);

async function runGit(repository: string, ...args: string[]): Promise<void> {
  await execute("git", args, { cwd: repository });
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "flint-e2e-repository-"));
  repositories.push(repository);
  await runGit(repository, "init", "-q");
  await runGit(repository, "config", "user.email", "e2e@example.test");
  await runGit(repository, "config", "user.name", "Flint E2E");
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "input.ts"), "export const input = 'before';\n");
  await runGit(repository, "add", "src/input.ts");
  await runGit(repository, "commit", "-qm", "initial");
  return repository;
}

async function createTask(page: Page, repository: string, prompt: string): Promise<void> {
  await page.goto("/projects");
  await page.locator("#root-path").fill(repository);
  await page.getByRole("button", { name: "Register repository" }).click();
  await page.getByLabel("Title").fill("E2E workflow task");
  await page.getByLabel("Codex prompt").fill(prompt);
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByRole("heading", { name: "E2E workflow task" })).toBeVisible();
}

test.afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => rm(repository, { recursive: true, force: true })));
});

test("completes the human-gated Codex and Claude workflow with an exact-session resume", async ({ page }) => {
  await createTask(page, await createRepository(), "Implement the requested change.");

  await page.getByRole("button", { name: "Start Codex development" }).click();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Claude review" }).click();
  await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();
  await expect(page.getByText("Validate input", { exact: true })).toBeVisible();

  const finding = page.getByText("Validate input", { exact: true }).locator("..");
  await finding.getByRole("checkbox").uncheck();
  await finding.getByRole("checkbox").check();
  await finding.getByPlaceholder("Add a human note…").fill("Keep the error response stable.");
  await page.getByRole("button", { name: "Regenerate preview" }).click();
  const feedback = page.getByPlaceholder("Select review findings, then generate a feedback preview…");
  await expect(feedback).toHaveValue(/Validate input/);
  await feedback.fill("Please fix the selected validation finding and retain the public error shape.");
  await page.getByRole("button", { name: "Resume Codex session →" }).click();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Claude review" }).click();
  await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.locator(".task-header").getByText("completed", { exact: true })).toBeVisible();
});

test("recovers persisted task state after a browser reload", async ({ page }) => {
  await createTask(page, await createRepository(), "Implement reload recovery.");
  await page.getByRole("button", { name: "Start Codex development" }).click();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "E2E workflow task" })).toBeVisible();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await expect(page.getByText("codex-session-fake-123", { exact: false })).toBeVisible();
});

test("surfaces a Fake Codex developer failure in the task activity", async ({ page }) => {
  await createTask(page, await createRepository(), "[e2e:fail] fail the developer run.");
  await page.getByRole("button", { name: "Start Codex development" }).click();
  await expect(page.locator(".activity-panel")).toContainText("Fake Codex E2E failure requested by test prompt");
  const codexPanel = page.locator(".agent-panel").filter({ has: page.getByRole("heading", { name: "Codex Developer" }) });
  await expect(codexPanel.getByText("failed", { exact: true })).toBeVisible();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue Codex" })).toBeVisible();
});
