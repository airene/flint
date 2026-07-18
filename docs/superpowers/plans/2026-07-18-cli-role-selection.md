# CLI Role Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the globally configured Developer and Reviewer CLI selectable from the registered CLI providers while preserving each task's original role/session assignment.

**Architecture:** A server-side provider registry supplies dynamic Settings options and role capabilities. Global role defaults live in `app_settings`; each task snapshots both providers. Drivers receive the run type and construct role-specific arguments, while session persistence and UI grouping use roles rather than provider names.

**Tech Stack:** Bun, TypeScript, Vue 3, Pinia, Zod, Drizzle ORM, SQLite, Playwright.

## Global Constraints

- Role changes affect only tasks created after the setting is saved.
- Dropdowns list registered providers; unavailable or unauthenticated entries remain visible and disabled.
- Codex and Claude both support Developer and Reviewer roles.
- Claude Developer uses `acceptEdits`, never `bypassPermissions`.
- Existing databases and tasks retain Codex Developer / Claude Reviewer.
- Do not stage or commit any files.

---

### Task 1: Shared contracts, settings, and task snapshots

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/contracts.test.ts`
- Create: `apps/server/src/drivers/provider-registry.ts`
- Modify: `apps/server/src/services/app-settings.service.ts`
- Modify: `apps/server/src/db/database.ts`
- Modify: `apps/server/src/db/schema.ts`
- Modify: `apps/server/src/services/task.service.ts`
- Test: `tests/core/core.test.ts`
- Test: `tests/api/api.test.ts`

**Interfaces:**
- Produces `AgentRole`, `ProviderDescriptor`, `AgentRoleSettings`, task `developerProvider` / `reviewerProvider`, and `AppSettingsService.loadAgentRoles()`.
- Provider descriptors contain `id`, `label`, `roles`, and `availability` in API responses.

- [ ] Add failing contract and persistence tests that parse dynamic providers, save role defaults, migrate an existing tasks table, snapshot defaults on task creation, and prove later setting changes do not mutate an existing task.
- [ ] Run `bun test packages/shared/src/contracts.test.ts tests/core/core.test.ts tests/api/api.test.ts` and confirm failures are caused by the missing role contracts/columns.
- [ ] Broaden project/provider schemas, add strict Settings request/response fields, add registry definitions, persist role keys, and add idempotent task-column migration with legacy defaults.
- [ ] Inject a role-settings reader into `TaskService` and copy the current defaults into every new task.
- [ ] Re-run the focused tests and require zero failures.

### Task 2: Role-aware drivers and session ownership

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/drivers/cli-arguments.ts`
- Modify: `apps/server/src/drivers/streaming-cli.driver.ts`
- Modify: `apps/server/src/drivers/codex-cli.driver.ts`
- Modify: `apps/server/src/drivers/claude-cli.driver.ts`
- Modify: `apps/server/src/services/agent-run.service.ts`
- Modify: `apps/server/src/api/database-ports.ts`
- Modify: `apps/server/src/api/application.ts`
- Test: `tests/agents/cli-configuration.test.ts`
- Test: `tests/agents/drivers.test.ts`
- Test: `tests/agents/agent-run.service.test.ts`
- Test: `tests/review/review.service.test.ts`

**Interfaces:**
- `AgentStartRequest.runType: AgentRunType` selects role-specific arguments.
- `AgentRunService` selects `task.developerProvider` for developer run types and `task.reviewerProvider` for reviewer runs.
- `recordSession(runId, taskId, runType, sessionId)` stores session ownership by role.

- [ ] Add failing tests for all four provider/role argument combinations, Codex structured review parsing, task-based provider selection, and developer/reviewer session persistence independent of provider.
- [ ] Run the four focused test files and confirm the new expectations fail.
- [ ] Generate a temporary Codex review schema for the application lifetime, pass `read-only --output-schema` for reviewer runs, and parse the final JSON agent message.
- [ ] Make Claude arguments role-aware: reviewer retains the existing restrictions/schema; developer uses `acceptEdits` without reviewer schema/tool restrictions.
- [ ] Replace provider hardcoding in run selection, API availability checks, feedback resume, and database session mapping with task role providers/run type.
- [ ] Re-run the focused tests and require zero failures.

### Task 3: Dynamic Settings and task-role UI

**Files:**
- Modify: `apps/web/src/stores/system.ts`
- Modify: `apps/web/src/views/SettingsView.vue`
- Modify: `apps/web/src/views/TaskView.vue`
- Modify: `apps/web/src/components/TaskHeader.vue`
- Modify: `apps/web/src/api/endpoints.ts`
- Test: `tests/web/api-client.test.ts`
- Test: `tests/e2e/workflow.e2e.ts`

**Interfaces:**
- `CliStatusResponse.providers` drives cards, dropdowns, labels, and provider readiness.
- `CliRecheckRequest.defaultDeveloper/defaultReviewer` saves role defaults with executable overrides.

- [ ] Add failing API-client and E2E assertions for registry-driven dropdowns, disabled unavailable providers, saved defaults, and dynamic task panel titles.
- [ ] Run the focused web/E2E tests and confirm the UI expectations fail.
- [ ] Refactor the system store to expose provider lookup/readiness helpers and render Settings cards/options from descriptors.
- [ ] Bind both selects to the existing Save & recheck action, preserving unchanged unavailable selections.
- [ ] Group task runs by run type, derive titles/provider readiness from task snapshots, and replace fixed Codex session copy.
- [ ] Re-run focused tests and require zero failures.

### Task 4: Full workflow matrix and verification

**Files:**
- Modify: `tests/fixtures/bin/codex`
- Modify: `tests/fixtures/bin/claude`
- Modify: `tests/e2e/workflow.e2e.ts`
- Modify only implementation files implicated by failures.

**Interfaces:**
- Fake CLIs emit valid developer and structured reviewer streams for either provider.

- [ ] Extend fixtures and tests to exercise Codex→Claude and Claude→Codex full workflows, including exact-session feedback resume.
- [ ] Run `bun test` outside the sandbox and require all unit/integration tests to pass.
- [ ] Run `bun run test:e2e` outside the sandbox and require all Playwright tests to pass.
- [ ] Run `bun run typecheck`, `bun run build`, and `git diff --check`.
- [ ] Inspect `/settings` and one task in the live browser, then request independent code review, fix valid findings, and repeat verification.
