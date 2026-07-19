# Approval Relay Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for approval state transitions and `superpowers:verification-before-completion` before handing the branch back.

**Goal:** Relay structured Developer permission requests to the page and return exactly one allow-once or deny decision to the originating CLI request.

**Architecture:** An approval service maps provider request IDs to durable records, redacts display details, enforces idempotent decisions, and expires unresolved requests when their Run ends. A standalone card renders state and emits a decision; integration owns event and API wiring.

**Tech Stack:** TypeScript, provider control adapters, Vue 3, Bun test

---

## Worktree Contract

- **Branch:** `codex/approval-relay`
- **Depends on:** merged `codex/interaction-foundation` and `codex/provider-control`.
- **Owns:** `apps/server/src/services/approval.service.ts` (new), `apps/web/src/components/ApprovalCard.vue` (new), `apps/web/src/components/approval-card.ts` (new), `tests/approvals/approval.service.test.ts` (new), `tests/web/approval-card.test.ts` (new).
- **Must not edit:** shared/database files, provider drivers, `agent-run.service.ts`, `application.ts`, event service/hub, `ActivityPanel.vue`, endpoints/stores/views, broad API/E2E tests, or README.
- **Handoff:** committed approval domain service and standalone card with explicit integration hooks.

## Task 1: Implement durable approval state

Write failing tests, then implement request creation from a provider request ID, redacted command/action summary, `pending/resolved/expired` transitions, allow-once/deny only, duplicate-decision idempotency, and automatic expiry on Run terminal state. Reject every Reviewer approval request as a recorded security error. If the provider lacks approval control, return a capability error rather than a pending record.

Run: `bun test tests/approvals/approval.service.test.ts`

## Task 2: Implement the standalone approval card

Write failing tests for pending, resolving, allowed, denied, expired, retry, optional deny reason, and duplicate-click disablement. Implement a card that receives sanitized request data and emits one typed decision; it must not call global stores or endpoints directly.

Run: `bun test tests/web/approval-card.test.ts`

## Task 3: Verify and commit

Run:

```bash
bun test tests/approvals/approval.service.test.ts tests/web/approval-card.test.ts
bun run typecheck
git diff --check
```

Stage only the owned files and commit with message: `feat: add page approval relay modules`.
