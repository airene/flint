# Interaction Foundation Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for each task and `superpowers:verification-before-completion` before handing the branch back.

**Goal:** Establish the shared types, validation schemas, persistence tables, and database ports required by every interactive feature.

**Architecture:** Keep this serial foundation behavior-free. It defines durable records and provider-facing contracts, while feature services and top-level wiring remain in downstream worktrees.

**Tech Stack:** TypeScript, Zod, Drizzle ORM, SQLite, Bun test

---

## Worktree Contract

- **Branch:** `codex/interaction-foundation`
- **Depends on:** current integration target only; this is Wave 0.
- **Owns:** `packages/shared/src/index.ts`, `packages/shared/src/contracts.test.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/database.ts`, `apps/server/src/api/database-ports.ts`, `tests/core/core.test.ts`.
- **Must not edit:** application routes, provider drivers, feature services, Vue files, realtime entry points, API/E2E integration tests, or README.
- **Handoff:** one committed branch exporting stable contracts and persistence operations that downstream plans can consume without editing these files.

## Task 1: Define shared contracts

Add failing contract tests, then extend the shared schemas and types for:

- `TaskMessage`, attachment draft/claimed state, and `ApprovalRequest` with allow-once/deny decisions;
- `UnfinishedTaskSummary`, attention state, message and approval event types;
- `developer_followup` and `reviewer_followup` Run types without changing the meaning of a formal `reviewer` Run;
- provider capabilities split by role and delivery phase: initial image, resumed image, live messages, interruption, and approvals;
- create-Task and message requests carrying attachment IDs, with strict validation and bounded counts.

Run: `bun test packages/shared/src/contracts.test.ts`

## Task 2: Add persistence and atomic ports

Write failing database tests in `tests/core/core.test.ts`, then add tables/indexes and `DatabasePorts` operations for messages, attachments, approvals, unfinished summaries, and exact-session lookup. Enforce project/task ownership, one-time attachment claim, idempotent approval decisions, and at most one active Run per Task at the database boundary. Keep filesystem movement and orchestration outside this plan.

Run: `bun test tests/core/core.test.ts`

## Task 3: Verify and commit

Run:

```bash
bun test packages/shared/src/contracts.test.ts tests/core/core.test.ts
bun run typecheck
git diff --check
```

Stage only the owned files and commit with message: `feat: add interactive workflow foundation`.
