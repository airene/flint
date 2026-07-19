# Browser Notifications Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for notification policy and settings behavior and `superpowers:verification-before-completion` before handing the branch back.

**Goal:** Notify once when a Developer or Reviewer Run on the currently open Task completes successfully while the page is hidden.

**Architecture:** Keep browser notification policy as a pure event gate with injected Notification/document/navigation adapters. Store enablement and per-current-Task cursor locally. Integration later feeds it only the current Task's persisted event stream.

**Tech Stack:** TypeScript, Vue 3, Browser Notification API, localStorage, Bun test

---

## Worktree Contract

- **Branch:** `codex/browser-notifications`
- **Depends on:** merged `codex/interaction-foundation`.
- **Owns:** `apps/web/src/realtime/browser-notifications.ts` (new), `apps/web/src/stores/notification-settings.ts` (new), `apps/web/src/components/NotificationSettings.vue` (new), `tests/web/browser-notifications.test.ts` (new), `tests/web/notification-settings.test.ts` (new).
- **Must not edit:** server files, shared contracts, `task-events.ts`, `endpoints.ts`, `App.vue`, task/settings views, `system.ts`, `task-workspace.ts`, broad API/E2E tests, or README.
- **Handoff:** committed pure policy/settings modules and a settings component with an explicit event-consumer API.

## Task 1: Implement the exact notification gate

Write failing tests, then implement policy that notifies only when permission is `granted`, notifications are enabled, the document is hidden, and the persisted event belongs to the currently open Task. Allow one notification only for Developer/Reviewer `run_completed`; reject failure/cancel/interruption, approval, turn/tool/command/message events, and events for other Tasks. Deduplicate with Task ID plus event sequence.

Run: `bun test tests/web/browser-notifications.test.ts`

## Task 2: Implement opt-in settings and click behavior

Write failing tests for user-initiated permission request, denied/default/granted states, local enablement, per-current-Task cursor persistence, and notification click callbacks. Implement a component that never requests permission on mount. The click callback must focus/navigate an existing open app; do not add service workers or browser-closed delivery.

Run: `bun test tests/web/notification-settings.test.ts tests/web/browser-notifications.test.ts`

## Task 3: Verify and commit

Run:

```bash
bun test tests/web/browser-notifications.test.ts tests/web/notification-settings.test.ts
bun run typecheck
git diff --check
```

Stage only the owned files and commit with message: `feat: add current task browser notifications`.
