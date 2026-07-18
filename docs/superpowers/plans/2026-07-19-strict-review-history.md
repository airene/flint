# Strict Reviewer and Durable Review History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every Reviewer shell-write path and permanently isolate findings, notes, and feedback drafts by Review Run.

**Architecture:** GitService remains the only process allowed to execute Git for review setup and passes a captured patch into ReviewService. Review artifacts are keyed by `sourceReviewRunId`: findings are replaced only within one run, and a new SQLite-backed draft API stores one text value per successful Review Run.

**Tech Stack:** Bun, TypeScript, Vue 3, Pinia, Drizzle ORM, SQLite, Zod, Bun test, Playwright.

## Global Constraints

- Claude Reviewer exposes only `Read`, `Glob`, and `Grep`; no Bash tool is available.
- Codex Reviewer remains in its native `read-only` sandbox.
- Existing tasks and databases migrate forward without losing findings or deliveries.
- Every findings, selection, note, preview, draft, and send operation is scoped to one Review Run.
- No automatic Developer/Reviewer loop or historical comparison UI is added.

---

### Task 1: Strict Reviewer tool and context boundary

**Files:**
- Modify: `tests/agents/drivers.test.ts`
- Modify: `tests/review/review.service.test.ts`
- Modify: `apps/server/src/drivers/cli-arguments.ts`
- Modify: `apps/server/src/services/review.service.ts`
- Modify: `apps/server/src/api/application.ts`

**Interfaces:**
- `ReviewSnapshot` adds `trackedPatch: string` and `untrackedPatch: string`.
- `buildReviewPrompt(input)` consumes `trackedPatch` and `untrackedPatch` and embeds both as authoritative evidence.
- `buildClaudeArgs(executable, "reviewer")` emits `--safe-mode --tools Read Glob Grep` and never emits a Bash tool pattern.

- [ ] **Step 1: Write failing argument and prompt tests**

Add assertions equivalent to:

```ts
expect(invocation.args).toContain("--safe-mode");
const toolsIndex = invocation.args.indexOf("--tools");
expect(invocation.args.slice(toolsIndex + 1, toolsIndex + 4)).toEqual(["Read", "Glob", "Grep"]);
expect(invocation.args.some((argument: string) => argument.includes("Bash"))).toBe(false);

expect(prompt).toContain("diff --git a/src/input.ts b/src/input.ts");
expect(prompt).toContain("diff --git a/new.txt b/new.txt");
expect(prompt).not.toContain("请先用允许的只读命令");
```

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/agents/drivers.test.ts tests/review/review.service.test.ts`

Expected: the safe-mode/tool-list and supplied-patch assertions fail because Claude still receives Git Bash tools and ReviewService does not carry patches.

- [ ] **Step 3: Implement the strict boundary**

Use the explicit built-in tool list:

```ts
const REVIEW_TOOLS = ["Read", "Glob", "Grep"] as const;
// reviewer args include "--safe-mode", "--tools", ...REVIEW_TOOLS
```

Extend review capture and prompt construction:

```ts
export interface ReviewSnapshot {
  snapshotHash: string;
  gitStatus: string;
  diffStat: string;
  trackedPatch: string;
  untrackedPatch: string;
}
```

Application assembly maps `capture.diff.trackedPatch` and `capture.diff.untrackedPatch` into this port. The prompt embeds both patches inside clearly delimited sections and directs the reviewer to use file reads only for context.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/agents/drivers.test.ts tests/review/review.service.test.ts`

Expected: all focused tests pass with zero failures.

---

### Task 2: Preserve findings and notes per Review Run

**Files:**
- Modify: `tests/api/api.test.ts`
- Modify: `tests/core/core.test.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/api/database-ports.ts`
- Modify: `apps/server/src/api/application.ts`
- Modify: `apps/web/src/stores/task-workspace.ts`
- Modify: `apps/web/src/api/endpoints.ts`

**Interfaces:**
- `selectFindingsRequestSchema` becomes `{ sourceReviewRunId: string; mode: FindingSelectionMode }`.
- `replaceFindings(taskId, runId, findings)` deletes only `review_findings.run_id = runId`.
- `selectFindings(taskId, runId, mode)` updates only findings owned by the requested run.

- [ ] **Step 1: Write failing history and run-scoped selection tests**

Create two successful Review Runs for one task, attach a note to the first run, and assert:

```ts
expect(allFindings.map((finding) => finding.runId)).toEqual([firstRunId, secondRunId]);
expect(allFindings.find((finding) => finding.runId === firstRunId)?.userNote)
  .toBe("Keep the public error shape.");
```

Send a bulk-selection request for the second run and assert the first run's selection remains unchanged.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test tests/api/api.test.ts tests/core/core.test.ts packages/shared/src/contracts.test.ts`

Expected: the first run's finding is missing or altered because persistence and bulk selection are task-scoped.

- [ ] **Step 3: Implement run-scoped persistence and selection**

Change the delete predicate to `eq(reviewFindings.runId, runId)`. Add `sourceReviewRunId` to the contract and pass it through the API to:

```ts
async selectFindings(taskId: string, runId: string, mode: FindingSelectionMode): Promise<ReviewFinding[]>
```

Validate the Review Run belongs to the task before selecting. Return only the selected run's findings from this mutation while the list endpoint continues returning task history.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test tests/api/api.test.ts tests/core/core.test.ts packages/shared/src/contracts.test.ts`

Expected: all focused tests pass and both Review Runs retain independent findings and notes.

---

### Task 3: Persist one feedback draft per Review Run

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/db/database.ts`
- Modify: `apps/server/src/api/database-ports.ts`
- Modify: `apps/server/src/api/application.ts`
- Modify: `apps/web/src/api/endpoints.ts`
- Modify: `apps/web/src/stores/task-workspace.ts`
- Modify: `apps/web/src/views/TaskView.vue`
- Modify: `tests/api/api.test.ts`
- Modify: `tests/web/api-client.test.ts`
- Modify: `tests/web/task-workspace-store.test.ts`

**Interfaces:**
- `FeedbackDraft = { taskId, sourceReviewRunId, finalText, createdAt, updatedAt }`.
- `GET /api/tasks/:taskId/reviews/:runId/feedback-draft` returns `{ draft: FeedbackDraft | null }`.
- `PUT /api/tasks/:taskId/reviews/:runId/feedback-draft` consumes `{ finalText: string }` and returns `FeedbackDraft`.
- `DatabasePorts.getFeedbackDraft(taskId, runId)` and `saveFeedbackDraft(candidate)` own persistence.

- [ ] **Step 1: Write failing schema, API, client, and store tests**

Assert a generated preview is returned by GET after reload, a PUT edit survives another GET, and separate run IDs return separate text. Add a pure store helper test showing the latest successful Review is selected even when findings from older reviews are retained.

- [ ] **Step 2: Run tests and verify RED**

Run: `bun test packages/shared/src/contracts.test.ts tests/api/api.test.ts tests/web/api-client.test.ts tests/web/task-workspace-store.test.ts`

Expected: draft schemas, routes, and client methods are missing; the old latest-review helper rejects mixed historical findings.

- [ ] **Step 3: Implement schema and SQLite persistence**

Add:

```sql
CREATE TABLE IF NOT EXISTS feedback_drafts (
  source_review_run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  final_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The Drizzle table mirrors this schema. Upsert on `source_review_run_id`, preserving `created_at` and updating `final_text`/`updated_at`.

- [ ] **Step 4: Implement routes and lifecycle persistence**

Validate source ownership/status before reads and writes. Preview upserts its generated text. Send upserts `finalText` before reserving a delivery. Completed tasks remain readable and reject draft writes.

- [ ] **Step 5: Implement web draft isolation**

Compute the latest successful Reviewer independently of historical findings. Filter editable/selected findings by that run. Load its persisted draft during load/refresh, clear the editor when no draft exists, and expose `updateFeedbackText(text)` for debounced run-bound saves. TaskView calls this action instead of assigning `feedbackText` directly.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `bun test packages/shared/src/contracts.test.ts tests/api/api.test.ts tests/web/api-client.test.ts tests/web/task-workspace-store.test.ts`

Expected: all focused tests pass, drafts reload and remain isolated by Review Run.

---

### Task 4: Remove completed findings from review reports and verify the repository

**Files:**
- Modify: `docs/agentA.md`
- Modify: `docs/agentB.md`

**Interfaces:** None.

- [ ] **Step 1: Remove only the resolved report content**

Delete Agent A's strict-readonly and stale-feedback sections and related repair/decision bullets. Delete Agent B's historical-finding deletion section and any recommendation that describes it as outstanding. Preserve unrelated Git performance, event, CI, recovery, security, and feature suggestions.

- [ ] **Step 2: Run complete verification**

Run:

```text
bun run typecheck
bun test
bun run build
bun run test:e2e
git diff --check
git status --short
```

Expected: typecheck, all Bun tests, build, and Playwright E2E pass; diff check reports no whitespace errors; status contains only files intentionally changed by this plan.
