import { expect, test, type Page, type Route } from "@playwright/test";
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

// Creating a task auto-starts the fixed Developer run (Create & start), so callers
// should assert on the resulting run/task state instead of a draft Start button.
async function createTask(page: Page, repository: string, prompt: string, developerLabel = "Codex"): Promise<void> {
  await page.goto("/projects");
  await page.locator("#root-path").fill(repository);
  await page.getByRole("button", { name: "Register repository" }).click();
  await page.getByLabel("Title").fill("E2E workflow task");
  await page.getByLabel(`${developerLabel} prompt`).fill(prompt);
  await page.getByRole("button", { name: `Create & start ${developerLabel}` }).click();
  await expect(page.getByRole("heading", { name: "E2E workflow task" })).toBeVisible();
}

test.afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => rm(repository, { recursive: true, force: true })));
});

test("records a repository as opened when its workspace is visited", async ({ page }) => {
  const repository = await createRepository();
  await page.goto("/projects");
  await page.locator("#root-path").fill(repository);
  await page.getByRole("button", { name: "Register repository" }).click();
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();

  await page.goto("/projects");
  await expect(page.getByText(/^Opened /)).toBeVisible();
  await expect(page.getByText("Not opened yet", { exact: true })).toHaveCount(0);
});

test("inserts file mentions in new-task and persisted Developer follow-ups without changing closed-menu Enter behavior", async ({ page }) => {
  const repository = await createRepository();
  await page.goto("/projects");
  await page.locator("#root-path").fill(repository);
  await page.getByRole("button", { name: "Register repository" }).click();
  await page.getByLabel("Title").fill("File mention task");

  const initialPrompt = page.getByLabel("Codex prompt");
  await initialPrompt.fill("Use @inp");
  await expect(page.getByRole("option", { name: "src/input.ts" })).toBeVisible();
  await initialPrompt.press("Tab");
  await expect(initialPrompt).toHaveValue("Use @src/input.ts ");
  await initialPrompt.press("Enter");
  await expect(initialPrompt).toHaveValue("Use @src/input.ts \n");
  await initialPrompt.fill("Use @src/input.ts to implement the change.");
  await page.getByRole("button", { name: "Create & start Codex" }).click();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();

  const continuation = page.getByLabel("Codex developer follow-up message");
  await continuation.fill("Recheck @inp");
  await continuation.press("Enter");
  await expect(page.getByRole("button", { name: "Select Developer run 2" })).toHaveCount(0);
  await expect(continuation).toHaveValue("Recheck @inp");
  await expect(page.getByRole("option", { name: "src/input.ts" })).toBeVisible();
  await continuation.press("ArrowDown");
  await continuation.press("Enter");
  await expect(continuation).toHaveValue("Recheck @src/input.ts ");
  await expect(page.getByRole("button", { name: "Select Developer run 2" })).toHaveCount(0);
  await continuation.press("Enter");
  await page.locator(".conversation-panel").getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Select Developer run 2" })).toBeVisible();
});

test("shows the configured CLI models on Settings", async ({ page }) => {
  await page.goto("/settings");

  const developer = page.getByLabel("Developer CLI");
  const reviewer = page.getByLabel("Reviewer CLI");
  await expect(developer).toHaveValue("codex");
  await expect(reviewer).toHaveValue("claude");
  await expect(developer.locator("option")).toHaveCount(2);
  await expect(reviewer.locator("option")).toHaveCount(2);
  await expect(page.getByText("gpt-5.6-test", { exact: true })).toBeVisible();
  await expect(page.getByText("high", { exact: true })).toBeVisible();
  await expect(page.getByText("default", { exact: true })).toBeVisible();
});

test("saves registry-driven role defaults and snapshots dynamic task panel titles", async ({ page, request }) => {
  try {
    await page.goto("/settings");
    await page.getByLabel("Developer CLI").selectOption("claude");
    await page.getByLabel("Reviewer CLI").selectOption("codex");
    await page.getByRole("button", { name: "Save & recheck" }).click();
    await expect(page.getByLabel("Developer CLI")).toHaveValue("claude");
    await expect(page.getByLabel("Reviewer CLI")).toHaveValue("codex");

    await createTask(page, await createRepository(), "Exercise role-specific task panels.", "Claude Code");
    await expect(page.getByText("Claude Code session", { exact: true })).toBeVisible();
    await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Claude Code Developer #1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start Codex review" }).click();
    await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Codex Reviewer #1", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Codex Review", exact: true })).toBeVisible();
    await page.getByPlaceholder("Select review findings, then generate a feedback preview…")
      .fill("Resume the configured Claude developer session.");
    await page.getByRole("button", { name: "Resume Claude Code session →" }).click();
    await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  } finally {
    await request.post("/api/system/settings", {
      data: { developerProvider: "codex", reviewerProvider: "claude" },
    });
  }
});

test("keeps same-provider Developer and Reviewer stream events isolated by run", async ({ page, request }) => {
  try {
    await request.post("/api/system/settings", {
      data: { developerProvider: "codex", reviewerProvider: "codex" },
    });
    await createTask(page, await createRepository(), "Keep same-provider streams isolated.");
    await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start Codex review" }).click();
    await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();

    const history = page.getByRole("region", { name: "Run history" });
    const runDetail = page.locator(".agent-panel");
    const activity = page.locator(".activity-panel");
    await history.getByRole("button", { name: "Select Developer run 1" }).click();
    await runDetail.locator("summary").click();
    await expect(runDetail.locator(".event-lines")).toContainText("Fake Codex completed the requested change.");
    await expect(runDetail.locator(".event-lines")).not.toContainText("Codex review");
    await expect(activity).toContainText("Fake Codex completed the requested change.");
    await expect(activity).not.toContainText("Codex review");

    await history.getByRole("button", { name: "Select Reviewer run 1" }).click();
    await runDetail.locator("summary").click();
    await expect(runDetail.locator(".event-lines")).toContainText("Codex review");
    await expect(runDetail.locator(".event-lines")).not.toContainText("Fake Codex completed the requested change.");
    await expect(activity).toContainText("Codex review");
    await expect(activity).not.toContainText("Fake Codex completed the requested change.");

    const reviewerFollowup = page.getByLabel("Codex reviewer follow-up message");
    await reviewerFollowup.fill("Clarify the selected formal review without changing Task state.");
    await page.locator(".conversation-panel").getByRole("button", { name: "Send" }).click();
    await expect(page.getByRole("button", { name: "Select Reviewer run 2" })).toBeVisible();
    await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();
    await expect(page.locator(".message-list")).toContainText("delivered");
  } finally {
    await request.post("/api/system/settings", {
      data: { developerProvider: "codex", reviewerProvider: "claude" },
    });
  }
});

test("keeps a saved unavailable provider selected while disabling its options", async ({ page, request }) => {
  try {
    const response = await request.post("/api/system/settings", {
      data: { codexExecutable: "/definitely/missing/codex", developerProvider: "codex", reviewerProvider: "codex" },
    });
    expect(response.ok()).toBe(true);

    await page.goto("/settings");
    const developer = page.getByLabel("Developer CLI");
    const reviewer = page.getByLabel("Reviewer CLI");
    await expect(developer).toHaveValue("codex");
    await expect(reviewer).toHaveValue("codex");
    await expect(developer.locator('option[value="codex"]')).toHaveAttribute("disabled", "");
    await expect(reviewer.locator('option[value="codex"]')).toHaveAttribute("disabled", "");
    await page.getByRole("button", { name: "Save & recheck" }).click();
    await expect(reviewer).toHaveValue("codex");
  } finally {
    await request.post("/api/system/settings", {
      data: { codexExecutable: null, developerProvider: "codex", reviewerProvider: "claude" },
    });
  }
});

test("completes the human-gated Codex and Claude workflow with an exact-session resume", async ({ page }) => {
  await createTask(page, await createRepository(), "Implement the requested change.");

  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Claude Code review" }).click();
  await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();
  await expect(page.getByText("Validate input · initial", { exact: true })).toBeVisible();

  const finding = page.getByText("Validate input · initial", { exact: true }).locator("..");
  await finding.getByRole("checkbox").uncheck();
  await finding.getByRole("checkbox").check();
  await finding.getByPlaceholder("Add a human note…").fill("Keep the error response stable.");
  await page.getByRole("button", { name: "Regenerate preview" }).click();
  const feedback = page.getByPlaceholder("Select review findings, then generate a feedback preview…");
  await expect(feedback).toHaveValue(/Validate input/);
  await feedback.fill("Please fix the selected validation finding and retain the public error shape.");
  const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect.poll(async () => {
    const runsResponse = await page.request.get(`/api/tasks/${taskId}/runs`);
    const runs = await runsResponse.json() as Array<{ id: string; runType: string }>;
    const reviewRunId = runs.find((run) => run.runType === "reviewer")?.id;
    if (!reviewRunId) return "";
    const response = await page.request.get(`/api/tasks/${taskId}/reviews/${reviewRunId}/feedback-draft`);
    if (!response.ok()) return "";
    const result = await response.json() as { draft: { finalText: string } | null };
    return result.draft?.finalText ?? "";
  }).toBe("Please fix the selected validation finding and retain the public error shape.");
  await page.reload();
  await expect(feedback).toHaveValue("Please fix the selected validation finding and retain the public error shape.");
  await page.getByRole("button", { name: "Resume Codex session →" }).click();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Claude Code review" }).click();
  await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await expect(page.locator(".task-header").getByText("completed", { exact: true })).toBeVisible();
});

test("flushes the current review draft before starting a later review", async ({ page }) => {
  await createTask(page, await createRepository(), "Keep every review draft isolated.");
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Claude Code review" }).click();
  await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();

  const firstDraftText = "Keep this first review draft permanently.";
  const feedback = page.getByPlaceholder("Select review findings, then generate a feedback preview…");
  await feedback.fill(firstDraftText);
  await page.getByRole("button", { name: "Start Claude Code review" }).click();
  await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();
  await expect(feedback).toHaveValue("");

  const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
  const runsResponse = await page.request.get(`/api/tasks/${taskId}/runs`);
  const runs = await runsResponse.json() as Array<{ id: string; runType: string }>;
  const reviewRunIds = runs.filter((run) => run.runType === "reviewer").map((run) => run.id);
  expect(reviewRunIds).toHaveLength(2);
  const firstDraftResponse = await page.request.get(
    `/api/tasks/${taskId}/reviews/${reviewRunIds[0]}/feedback-draft`,
  );
  expect(firstDraftResponse.ok()).toBe(true);
  const firstDraft = await firstDraftResponse.json() as { draft: { finalText: string } | null };
  expect(firstDraft.draft?.finalText).toBe(firstDraftText);
});

test("selects and restores exact runs from task history", async ({ page }) => {
  const initialPrompt = "Implement history replay without losing the original result.";
  await createTask(page, await createRepository(), initialPrompt);

  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start Claude Code review" }).click();
  await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();

  const history = page.getByRole("region", { name: "Run history" });
  const developerOne = history.getByRole("button", { name: "Select Developer run 1" });
  const reviewerOne = history.getByRole("button", { name: "Select Reviewer run 1" });
  await expect(reviewerOne).toHaveAttribute("aria-pressed", "true");
  const selectedReview = page.locator(".review-panel");
  await expect(selectedReview.getByText("Initial review found one issue.", { exact: true })).toBeVisible();
  await expect(selectedReview.getByText("Validate input · initial", { exact: true })).toBeVisible();

  const feedback = page.getByPlaceholder("Select review findings, then generate a feedback preview…");
  await feedback.fill("Please fix the selected validation finding and retain the public error shape.");
  await page.getByRole("button", { name: "Resume Codex session →" }).click();

  const developerTwo = history.getByRole("button", { name: "Select Developer run 2" });
  await expect(developerTwo).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();

  await reviewerOne.click();
  const supersededReview = page.locator(".review-panel");
  await expect(supersededReview.getByRole("checkbox").first()).toBeDisabled();
  await expect(supersededReview.getByRole("button", { name: "All", exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Select review findings, then generate a feedback preview…")).toHaveCount(0);

  await developerOne.click();
  await expect(developerOne).toHaveAttribute("aria-pressed", "true");
  const runDetail = page.locator(".agent-panel");
  await expect(runDetail.getByText(initialPrompt, { exact: true })).toBeVisible();
  await expect(runDetail.getByText("Fake Codex completed the requested change.", { exact: true })).toBeVisible();

  const taskId = new URL(page.url()).pathname.split("/").at(-1)!;
  const runsRoute = `**/api/tasks/${taskId}/runs`;
  const refreshMarker = "Developer #1 final response replaced by refresh route.";
  const refreshHandler = async (route: Route): Promise<void> => {
    const response = await route.fetch();
    const runs = await response.json() as Array<Record<string, unknown>>;
    await route.fulfill({
      response,
      json: runs.map((run) => run.runType === "developer_initial" ? { ...run, finalMessage: refreshMarker } : run),
    });
  };
  await page.route(runsRoute, refreshHandler);
  try {
    await page.locator(".diff-chip").click();
    const diffDrawer = page.getByRole("dialog", { name: "Git diff" });
    await diffDrawer.getByRole("button", { name: "↻ Refresh" }).click();
    await expect(runDetail.getByText(refreshMarker, { exact: true })).toBeVisible();
    await expect(developerOne).toHaveAttribute("aria-pressed", "true");
    await diffDrawer.getByRole("button", { name: "✕ Close" }).click();
  } finally {
    await page.unroute(runsRoute, refreshHandler);
  }

  await page.getByRole("button", { name: "Start Claude Code review" }).click();
  const reviewerTwo = history.getByRole("button", { name: "Select Reviewer run 2" });
  await expect(reviewerTwo).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("waiting for human", { exact: true })).toBeVisible();
  await expect(selectedReview.getByText("Follow-up review found one issue.", { exact: true })).toBeVisible();
  await expect(selectedReview.getByText("Validate input · follow-up", { exact: true })).toBeVisible();

  await reviewerOne.click();
  const oldReview = page.locator(".review-panel");
  await expect(oldReview.getByText("Initial review found one issue.", { exact: true })).toBeVisible();
  await expect(oldReview.getByText("Validate input · initial", { exact: true })).toBeVisible();
  await expect(oldReview.getByText("Follow-up review found one issue.", { exact: true })).toHaveCount(0);
  await expect(oldReview.getByText("Validate input · follow-up", { exact: true })).toHaveCount(0);
  await expect(oldReview.getByRole("checkbox").first()).toBeDisabled();
  await expect(oldReview.getByPlaceholder("Add a human note…").first()).toBeDisabled();
  await expect(oldReview.getByRole("button", { name: "All", exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Select review findings, then generate a feedback preview…")).toHaveCount(0);

  await page.reload();
  await expect(history.getByRole("button", { name: "Select Reviewer run 2" })).toHaveAttribute("aria-pressed", "true");
});

test("recovers persisted task state after a browser reload", async ({ page }) => {
  await createTask(page, await createRepository(), "Implement reload recovery.");
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "E2E workflow task" })).toBeVisible();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  await expect(page.getByText("codex-session-fake-123", { exact: true })).toBeVisible();
});

test("surfaces a Fake Codex developer failure in the task activity", async ({ page }) => {
  await createTask(page, await createRepository(), "[e2e:fail] fail the developer run.");
  await expect(page.locator(".activity-panel")).toContainText("Fake Codex E2E failure requested by test prompt");
  const codexPanel = page.locator(".agent-panel").filter({ has: page.getByRole("heading", { name: "Codex Developer" }) });
  await expect(codexPanel.getByText("failed", { exact: true })).toBeVisible();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();
  const followup = page.getByLabel("Codex developer follow-up message");
  await expect(followup).toBeEnabled();
  await followup.fill("Retry the failed change in the established session.");
  await page.locator(".conversation-panel").getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Select Developer run 2" })).toBeVisible();
  await expect(page.locator(".message-list")).toContainText("delivered");
});
