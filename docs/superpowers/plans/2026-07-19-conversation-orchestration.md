# Conversation Orchestration Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for scheduling transitions and `superpowers:verification-before-completion` before handing the branch back.

**Goal:** Resume exact Developer or Reviewer sessions for follow-up messages while guaranteeing a single active Run per Task.

**Architecture:** A conversation service persists every message before delivery and serializes dispatch by Task. It asks `AgentRunService` to start or interrupt provider Runs but owns role-aware queue policy and exact-session selection.

**Tech Stack:** TypeScript, Bun, persisted queues, provider control adapters, Bun test

---

## Worktree Contract

- **Branch:** `codex/conversation-orchestration`
- **Depends on:** merged `codex/interaction-foundation` and `codex/provider-control`.
- **Owns:** `apps/server/src/services/conversation.service.ts` (new), `apps/server/src/services/agent-run.service.ts`, `apps/server/src/services/task-run-state.ts`, `tests/conversation/conversation.service.test.ts` (new), `tests/agents/agent-run.service.test.ts`, `tests/core/task-run-state.test.ts`.
- **Must not edit:** shared/database files, provider drivers, review/feedback/task services, application/event routes, web files, broad API/E2E tests, or README.
- **Handoff:** committed scheduling service and Run lifecycle support with no HTTP or page wiring.

## Task 1: Support follow-up Run lifecycles

Add failing Run-state tests, then support `developer_followup` and workflow-neutral `reviewer_followup`. A Developer follow-up follows `fixing → ready_for_review`; a Reviewer follow-up preserves the Task's prior status, remains read-only, and never creates formal findings. Require an exact stored target session and fail without falling back to the newest session.

Run: `bun test tests/agents/agent-run.service.test.ts tests/core/task-run-state.test.ts`

## Task 2: Implement the single-Run scheduler

Write table-driven failing tests for all active/target role combinations, then implement:

- idle target: dispatch immediately;
- same active role: FIFO queue by default, or interrupt then dispatch when explicitly requested;
- active Reviewer to Developer: always interrupt Reviewer, await terminal acknowledgement, discard incomplete formal findings, then dispatch Developer;
- active Developer to Reviewer: queue until Developer reaches a terminal state;
- multiple queued messages for the same next turn: preserve order and combine with visible separators.

Persist `queued → delivering → delivered/failed`, and never mark delivered merely because the HTTP request succeeded.

Run: `bun test tests/conversation/conversation.service.test.ts`

## Task 3: Verify and commit

Run:

```bash
bun test tests/conversation/conversation.service.test.ts tests/agents/agent-run.service.test.ts tests/core/task-run-state.test.ts
bun run typecheck
git diff --check
```

Stage only the owned files and commit with message: `feat: orchestrate task conversations`.
