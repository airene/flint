# Provider Control Implementation Plan

> **For Codex:** Use `superpowers:test-driven-development` for adapter changes and `superpowers:verification-before-completion` before handing the branch back.

**Goal:** Give Codex and Claude adapters explicit, tested capabilities for initial/resumed images, cancellation, live delivery, and structured approval control.

**Architecture:** Put provider differences behind a focused control interface. Callers inspect capabilities before starting a Run; unsupported operations return typed failures and never drop images or approval requests silently.

**Tech Stack:** TypeScript, Bun subprocesses, Codex CLI, Claude CLI, Bun test

---

## Worktree Contract

- **Branch:** `codex/provider-control`
- **Depends on:** merged `codex/interaction-foundation`.
- **Owns:** `apps/server/src/drivers/agent-control.ts` (new), `apps/server/src/drivers/streaming-cli.driver.ts`, `apps/server/src/drivers/codex-cli.driver.ts`, `apps/server/src/drivers/claude-cli.driver.ts`, `apps/server/src/drivers/cli-arguments.ts`, `apps/server/src/drivers/provider-registry.ts`, `tests/agents/drivers.test.ts`, `tests/agents/cli-configuration.test.ts`, `tests/agents/provider-capabilities.test.ts` (new), and the Codex/Claude fixture executables when required.
- **Must not edit:** shared contracts, database files, `agent-run.service.ts`, application routes, web files, or broad API/E2E tests.
- **Handoff:** a committed adapter layer with a capability matrix and focused tests; note any real CLI behavior that cannot be automated.

## Task 1: Make capabilities explicit

Add failing tests for independent `developerInitialImage`, `developerResumeImage`, `reviewerInitialImage`, `reviewerResumeImage`, `liveMessages`, `interrupt`, and `approvals` declarations. Implement registry/driver descriptors and typed unsupported-operation errors. Do not infer resume-image support from initial-image support.

Run: `bun test tests/agents/provider-capabilities.test.ts tests/agents/cli-configuration.test.ts`

## Task 2: Implement provider control paths

Add fixture-backed failing tests, then implement:

- Codex image arguments for new and resumed sessions using controlled absolute paths;
- Claude image behavior only for combinations proven by its non-interactive contract;
- cancellation/interruption with terminal acknowledgement;
- live message and structured approval hooks only where the provider protocol actually supports them.

Every unsupported combination must fail before process start with a user-displayable capability reason.

Run: `bun test tests/agents/drivers.test.ts tests/agents/provider-capabilities.test.ts`

## Task 3: Probe, verify, and commit

When real CLIs are available, run the smallest smoke probes for all four image combinations and record the observed matrix in the branch handoff. Then run:

```bash
bun test tests/agents/drivers.test.ts tests/agents/cli-configuration.test.ts tests/agents/provider-capabilities.test.ts
bun run typecheck
git diff --check
```

Stage only the owned files and commit with message: `feat: add provider interaction controls`.
