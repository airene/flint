# Strict Reviewer and Durable Review History Design

## Status

Approved by the project owner on 2026-07-19. The owner selected strict reviewer isolation and permanent per-review findings, notes, and feedback drafts.

## Goals

1. A Reviewer must not have a command or tool path that can modify the repository.
2. Every successfully parsed Review Run must retain its own findings and human edits permanently.
3. Every Review Run must have an independent persisted feedback draft so text from one review cannot be sent as another review's feedback.

## Non-goals

- Worktree isolation for Developer runs.
- Automatic Developer/Reviewer loops.
- A full review-comparison UI or editing historical reviews after the task has moved on.
- Replacing the existing post-review snapshot comparison.

## Strict Reviewer boundary

Flint captures the repository state before starting a Reviewer and injects the complete tracked and untracked patch into the review prompt. The prompt tells the Reviewer to treat this supplied patch as the authoritative change set and to use file-reading tools only when additional context is needed.

Claude Reviewer runs with `--safe-mode`, `--permission-mode plan`, and an explicit `--tools Read Glob Grep` list. It receives no Bash, Edit, Write, Notebook, MCP, hook, plugin, or project customization path. `--allowedTools` may still list the same read-only tools for non-interactive permission handling, while `--disallowedTools` remains a defense-in-depth denial list for write-capable built-ins.

Codex Reviewer continues to run with `--sandbox read-only`. It receives the same server-captured patch so reviewer behavior does not depend on running Git commands. The post-run snapshot hash comparison remains in place to detect an unexpected mutation, but it is not the primary access-control mechanism.

## Durable per-review findings

`review_findings` already stores `run_id`. Saving parsed findings will delete and replace rows for that Review Run only, never all rows for the task. Reprocessing one run remains idempotent while older review rows, selections, dismissals, and human notes remain untouched.

The findings list API continues to return all findings for a task so historical Review Runs remain renderable. UI calculations, bulk selection, preview generation, and feedback sending must filter by the selected source Review Run. A later successful or failed review must never change the findings or notes of an earlier run.

## Durable per-review feedback drafts

A new `feedback_drafts` table stores one row per source Review Run:

- `source_review_run_id` primary key and foreign key to `agent_runs`;
- `task_id` foreign key for ownership checks and task cleanup;
- `final_text`;
- `created_at` and `updated_at`.

The API exposes read and upsert operations scoped by task ID and Review Run ID. Both operations validate that the run belongs to the task, is a completed Reviewer run, and parsed successfully. Preview generation upserts the generated text. Manual textarea edits are saved through the upsert endpoint, and feedback sending performs a final upsert before creating the delivery.

The web store loads the draft belonging to the latest successful Review Run. When a new successful Review becomes current, it replaces the editor contents with that run's persisted draft or an empty string. It never carries text forward from the previous Review. Debounced manual saves are associated with the captured task/run pair so a late response cannot write text under a different Review Run.

## API and contract changes

- Add shared `FeedbackDraft`, get-draft response, and save-draft request/response schemas.
- Add `sourceReviewRunId` to the bulk finding selection request.
- Add `GET /api/tasks/:taskId/reviews/:runId/feedback-draft`.
- Add `PUT /api/tasks/:taskId/reviews/:runId/feedback-draft`.
- Keep existing finding update, preview, and send routes compatible apart from the now run-scoped bulk selection body.

## Error handling

- Draft access for a run from another task, a non-reviewer run, an unfinished run, or a parse-failed run returns the existing conflict response.
- A missing draft is represented as `{ draft: null }`, not a 404.
- Completed tasks keep findings and drafts readable. Existing completed-task write protection also applies to draft writes.
- Preview and send continue to reject dismissed, duplicate, or cross-review finding IDs.

## Tests

1. Claude Reviewer arguments expose only read-only built-ins and contain no Bash tool.
2. Review prompts contain the captured tracked and untracked patch and no instruction to execute Git.
3. Two successful Review Runs retain separate findings, selections, and human notes.
4. Bulk selection changes findings from only the requested Review Run.
5. Generated and manually edited drafts survive reload and remain isolated by Review Run ID.
6. Starting a later Review loads its own empty or saved draft rather than the previous review's text.
7. Existing API, unit, build, and browser workflows remain green.

## Rejected alternatives

- Git Bash allowlists were rejected because Git supports write-capable options such as `--output`, and parameter filtering cannot provide the same invariant as removing Bash.
- Keeping only the latest Review was rejected because it destroys human decisions and prevents an auditable review history.
- Keeping findings but clearing all drafts was rejected because manually curated feedback is part of the review record.
