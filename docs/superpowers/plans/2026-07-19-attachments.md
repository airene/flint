# Attachments Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for service and component behavior and `superpowers:verification-before-completion` before handing the branch back.

**Goal:** Support safe clipboard-image drafts that can be claimed by an initial Task or a later message and rendered in a reusable composer.

**Architecture:** A focused attachment service validates bytes and owns draft storage outside Git. UI components manage paste, upload, preview, removal, and capability messaging through injected callbacks; the integration worktree connects them to pages and API endpoints.

**Tech Stack:** TypeScript, Bun filesystem APIs, Vue 3, Vitest/Bun test

---

## Worktree Contract

- **Branch:** `codex/attachments`
- **Depends on:** merged `codex/interaction-foundation`.
- **Owns:** `apps/server/src/services/attachment.service.ts` (new), `apps/web/src/components/TaskComposer.vue` (new), `apps/web/src/components/AttachmentStrip.vue` (new), `apps/web/src/components/FileMentionInput.vue`, `tests/attachments/attachment.service.test.ts` (new), `tests/web/task-composer.test.ts` (new), `tests/web/file-mention.test.ts`.
- **Must not edit:** shared contracts/schema/database ports, `application.ts`, `endpoints.ts`, project/task views, global stores, realtime entry points, broad API/E2E tests, or README.
- **Handoff:** committed backend and UI modules with explicit integration inputs/outputs and no top-level wiring.

## Task 1: Build secure draft storage

Write failing service tests, then implement project-scoped upload, signature-based PNG/JPEG/WebP/non-animated-GIF validation, 10 MiB per-file and four-image per-message limits, controlled generated filenames, atomic claim to Task/message, retry-safe claim behavior, and expiry metadata. Prove files stay under the configured Flint data root and reject traversal, cross-project, expired, or already-claimed IDs.

Run: `bun test tests/attachments/attachment.service.test.ts`

## Task 2: Build the reusable composer

Write failing component/helper tests for `ClipboardEvent` image extraction, ordinary text paste, upload progress, preview/removal, upload failure, and provider capability disablement. Implement a composer that emits text plus claimed-ready attachment IDs but does not call global stores or route APIs directly.

Run: `bun test tests/web/task-composer.test.ts tests/web/file-mention.test.ts`

## Task 3: Verify and commit

Run:

```bash
bun test tests/attachments/attachment.service.test.ts tests/web/task-composer.test.ts tests/web/file-mention.test.ts
bun run typecheck
git diff --check
```

Stage only the owned files and commit with message: `feat: add clipboard attachment modules`.
