# README Agent Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the README describe Flint's configurable Developer and Reviewer roles instead of presenting Codex Developer and Claude Reviewer as fixed architecture.

**Architecture:** Keep the existing README structure and replace provider-specific product language with role-first language. Mention Codex/Claude where defaults, native permission modes, installation commands, or provider-specific smoke tests are relevant.

**Tech Stack:** Markdown, Git, ripgrep

## Global Constraints

- Preserve the user's existing `bun run dev` documentation change.
- Do not modify the user's existing `package.json` change.
- Do not change application code, behavior, or tests.
- Keep the README concise and suitable as the first project entry point.

---

### Task 1: Synchronize README with configurable agent roles

**Files:**
- Modify: `README.md`
- Verify: `docs/superpowers/specs/2026-07-18-cli-role-selection-design.md`

**Interfaces:**
- Consumes: Settings defaults `developerProvider` and `reviewerProvider`, task-level provider snapshots, provider-specific driver permissions, and exact Developer session resume behavior.
- Produces: An accurate README description of installation, configuration, security, workflow, limitations, and smoke tests.

- [ ] **Step 1: Update the project summary and prerequisites**

Describe configurable Developer/Reviewer roles, state the default Codex/Claude combination, and explain that at least one supported authenticated CLI is needed.

- [ ] **Step 2: Document Task role settings**

Add a `任务角色` subsection explaining that Codex and Claude currently support both roles, settings apply only to new tasks, and existing tasks retain their provider and exact session.

- [ ] **Step 3: Rewrite security and workflow sections around roles**

Describe Developer write permissions and Reviewer read-only enforcement, including the native Codex and Claude modes. Replace fixed provider names in the workflow and MVP loop limitation with Developer/Reviewer terminology.

- [ ] **Step 4: Verify stale wording and preserve existing changes**

Run:

```bash
rg -n "Codex 开发|Claude (review|评审)|Codex session|Codex/Claude 循环" README.md
git diff -- README.md
git diff -- package.json
```

Expected: No stale fixed-role product wording remains outside provider-specific defaults or smoke-test explanations; the existing one-command `bun run dev` change remains; `package.json` is untouched by this task.
