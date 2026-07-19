# Interactive Features Integration Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for integration behavior, `superpowers:requesting-code-review` before finalization, and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Wire all independently verified feature modules into Flint's API, realtime transport, pages, stores, and end-to-end workflow.

**Architecture:** This serial branch is the only owner of composition roots and broad tests. It consumes child modules without reimplementing their domain logic, resolves any final contract seams, and validates both umbrella specs as one coherent product flow.

**Tech Stack:** TypeScript, Bun, Hono, SQLite, Vue 3, WebSocket, Playwright, Bun test

---

## Worktree Contract

- **Branch:** `codex/interactive-features-integration`
- **Depends on:** merged `codex/interaction-foundation`, `codex/provider-control`, `codex/attachments`, `codex/task-attention`, `codex/browser-notifications`, `codex/conversation-orchestration`, and `codex/approval-relay`.
- **Owns shared server hotspots:** `apps/server/src/api/application.ts`, `apps/server/src/api/event-hub.ts`, `apps/server/src/services/event.service.ts`, `apps/server/src/services/task.service.ts`, `apps/server/src/services/review.service.ts`, `apps/server/src/services/feedback.service.ts`, and `apps/server/src/server.ts` if socket routing requires it.
- **Owns shared web hotspots:** `apps/web/src/api/endpoints.ts`, `apps/web/src/stores/projects.ts`, `apps/web/src/stores/task-workspace.ts`, `apps/web/src/stores/system.ts`, `apps/web/src/realtime/task-events.ts`, `apps/web/src/views/ProjectView.vue`, `apps/web/src/views/TaskView.vue`, `apps/web/src/views/SettingsView.vue`, `apps/web/src/components/ActivityPanel.vue`, `apps/web/src/App.vue`, `apps/web/src/router.ts`, and `apps/web/src/main.ts` if required.
- **Owns broad verification/docs:** `tests/api/api.test.ts`, `tests/api/event-hub.test.ts`, `tests/e2e/workflow.e2e.ts`, and `README.md`.
- **Must not edit:** child feature internals unless a verified contract defect makes integration impossible. Return such defects to the owning branch instead of silently absorbing feature work.
- **Handoff:** one committed, fully verified integration branch satisfying both umbrella specs.

## Task 1: Wire backend APIs and realtime events

Add failing API/event tests, then mount attachment draft upload, attachment-aware Task creation, message list/send, approval decision, and unfinished snapshot endpoints. Connect message/approval/Run terminal events to persisted task streams and lightweight app-level unfinished upsert/remove events. Enforce exact Review session selection, Reviewer read-only mode, one active Run per Task, attachment capability checks, and idempotent decisions at route boundaries.

Run: `bun test tests/api/api.test.ts tests/api/event-hub.test.ts`

## Task 2: Wire pages, stores, and notification policy

Add focused integration assertions where practical, then:

- use `TaskComposer` for initial Task creation and Developer/selected-Reviewer follow-up;
- display queue/delivery state, force Reviewer interruption for Developer changes, and wait when Developer is active before Reviewer follow-up;
- render approval cards in current Activity;
- show the realtime unfinished list with a leading state indicator under repositories;
- expose explicit browser-notification opt-in and feed only the current Task event stream to the notification gate.

Do not add Developer/Reviewer concurrency, background-Task notifications, browser-closed delivery, or turn/tool/command notifications.

Run: `bun run typecheck`

## Task 3: Prove the complete workflows

Extend E2E fixtures and tests for initial screenshots, resumed screenshots where supported, Review follow-up, running-message scheduling, forced Reviewer interruption, approval allow-once/deny, unfinished status updates, and one current-Task `run_completed` notification. Include explicit negative coverage for unsupported image delivery, duplicate approval decisions, non-current Tasks, failed/interrupted/approval events, and internal turn/tool events.

Run:

```bash
bun test
bun run typecheck
bun run test:e2e
git diff --check
```

Review the final diff against both umbrella specs, request code review, fix validated findings, then stage only the owned files and commit with message: `feat: integrate interactive task workflows`.
