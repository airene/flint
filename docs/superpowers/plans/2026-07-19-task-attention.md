# Task Attention Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for status derivation and stream reducers and `superpowers:verification-before-completion` before handing the branch back.

**Goal:** Produce a global, realtime, correctly sorted view of every Task whose status is not completed.

**Architecture:** A server service derives attention from persisted Task, Run, and approval state and exposes a focused snapshot handler. A separate client store/reducer handles app-level upsert/remove events. Integration later mounts the list and connects the common socket hub.

**Tech Stack:** TypeScript, SQLite, Hono-compatible Request/Response, Vue 3, WebSocket, Bun test

---

## Worktree Contract

- **Branch:** `codex/task-attention`
- **Depends on:** merged `codex/interaction-foundation`.
- **Owns:** `apps/server/src/services/unfinished-task.service.ts` (new), `apps/server/src/api/unfinished-tasks.ts` (new), `apps/web/src/stores/unfinished-tasks.ts` (new), `apps/web/src/realtime/unfinished-task-events.ts` (new), `apps/web/src/components/UnfinishedTaskList.vue` (new), `tests/tasks/unfinished-task.service.test.ts` (new), `tests/web/unfinished-tasks.test.ts` (new).
- **Must not edit:** shared/database files, `application.ts`, `event.service.ts`, `event-hub.ts`, `endpoints.ts`, `App.vue`, existing global stores/views, broad API/E2E tests, or README.
- **Handoff:** committed snapshot/derivation modules, socket reducer, and presentational list component with integration instructions.

## Task 1: Derive authoritative attention summaries

Write failing service tests for inclusion (`status !== "completed"`), attention priority (`待审核 > 需处理 > 执行中 > 待人工确认 > 可发起 Review > 其他`), latest-Run and pending-approval inputs, cross-project aggregation, and stable `updatedAt` ordering. Implement one query/service path that avoids per-Task Run queries.

Run: `bun test tests/tasks/unfinished-task.service.test.ts`

## Task 2: Build snapshot, reducer, and list modules

Write failing tests for snapshot serialization, realtime upsert/remove, reconnect snapshot replacement, current-Task highlighting, and accessible status labels. Implement a route handler that integration can mount at `GET /api/tasks/unfinished`, a lightweight event reducer that carries no prompt/activity body, and a presentational list component.

Run: `bun test tests/web/unfinished-tasks.test.ts tests/tasks/unfinished-task.service.test.ts`

## Task 3: Verify and commit

Run:

```bash
bun test tests/tasks/unfinished-task.service.test.ts tests/web/unfinished-tasks.test.ts
bun run typecheck
git diff --check
```

Stage only the owned files and commit with message: `feat: add unfinished task attention modules`.
