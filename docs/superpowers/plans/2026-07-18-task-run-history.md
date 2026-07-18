# Task Run History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a run-level History rail below the repository status strip and show the selected run's complete details, defaulting to the latest run.

**Architecture:** A small pure selection/history module owns ordering, role numbering, and stable selection behavior. `RunHistory.vue` renders the rail, while `TaskView.vue` binds the selected run to the existing detail, review, feedback, and activity components. Historical reviewer output falls back to immutable `AgentRun.structuredOutput`; only the current feedback review remains interactive.

**Tech Stack:** Vue 3, Pinia, TypeScript, Zod, Bun test, Playwright.

## Global Constraints

- One History item represents exactly one `AgentRun`.
- Initial load selects the latest Run; ordinary refreshes preserve a manual old selection; a newly added Run becomes selected.
- No database or API changes.
- Historical review annotations are out of scope; historical structured review output is read-only.
- Do not stage or commit files.

---

### Task 1: History model and rail

**Files:**
- Create: `apps/web/src/components/run-history.ts`
- Create: `apps/web/src/components/RunHistory.vue`
- Test: `tests/web/run-history.test.ts`

**Interfaces:**
- Produces `buildRunHistory(runs, providerLabel)` entries with `runId`, role label/ordinal, provider label, status, timestamp, and prompt summary.
- Produces `selectRunAfterUpdate(currentId, previousIds, runs)` for initial/latest, stable manual selection, and new-run selection.
- `RunHistory.vue` consumes entries and `selectedRunId`, and emits `select(runId)`.

- [x] Write failing unit tests for reverse ordering, role ordinals, prompt summaries, initial latest selection, stable old selection, invalid selection fallback, and new Run auto-selection.
- [x] Run `bun test tests/web/run-history.test.ts` and confirm failure because the module does not exist.
- [x] Implement the pure helpers and `RunHistory.vue` with status badges, accessible buttons, selected state, and empty state.
- [x] Re-run the focused unit test and require zero failures.

### Task 2: Historical reviewer result rendering

**Files:**
- Create: `apps/web/src/components/review-display.ts`
- Modify: `apps/web/src/components/ReviewPanel.vue`
- Test: `tests/web/review-display.test.ts`

**Interfaces:**
- `ReviewPanel` continues receiving `run` and current persisted `findings`, but derives a read-only fallback list from valid `run.structuredOutput.findings` when persisted findings do not belong to the selected run.
- Interactive selection, notes, dismiss, and feedback remain enabled only for the current feedback review.

- [x] Add failing unit tests that current persisted findings are used only when their `runId` matches, while an older valid Reviewer Run derives immutable display findings from `structuredOutput`.
- [x] Implement the pure display helper and refactor `ReviewPanel` to distinguish persisted current findings from immutable historical structured findings without changing the review result schema.
- [x] Run `bun test tests/web/review-display.test.ts` and require zero failures.

### Task 3: Task page integration and workflow verification

**Files:**
- Modify: `apps/web/src/views/TaskView.vue`
- Modify: `apps/web/src/components/RunHistory.vue`
- Modify: `apps/web/src/components/AgentPanel.vue`
- Modify: `apps/web/src/components/ActivityPanel.vue`
- Test: `tests/e2e/workflow.e2e.ts`

**Interfaces:**
- `TaskView` owns `selectedRunId`, derives `selectedRun`, and passes only the selected Run/events to detail components.
- `AgentPanel` renders one selected Run instead of internally selecting the latest from a role list.
- `ActivityPanel` receives events already scoped to the selected Run.

- [x] Add failing E2E assertions that the History defaults to the latest Run, clicking the first Developer Run restores its original prompt/result, and starting a new Run selects it automatically.
- [x] Replace the two latest-only Agent panels with the History rail and unified selected Run detail while preserving TaskHeader actions, ReviewPanel feedback rules, and the diff drawer.
- [x] Ensure manual selection is preserved across event/status refreshes and reset on task changes.
- [x] Run `bun test`, `bun run test:e2e`, `bun run typecheck`, `bun run build`, and `git diff --check`.
- [x] Inspect the supplied live task URL, request independent code review, fix valid findings, and repeat verification.
