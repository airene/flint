# Flint — local pair review

Flint is a local-only workflow for a human to coordinate Codex development and Claude review in an existing Git repository. It preserves the review and feedback gate: findings are never sent automatically, and Codex resumes only with the exact persisted session ID.

## Install and CLI prerequisites

Flint requires Bun 1.3 or newer, Git, the Codex CLI, and Claude Code. The versions verified for this checkout are Bun `1.3.14` and Git `2.50.1 (Apple Git-155)`. Codex and Claude versions are detected at runtime and displayed in **CLI Settings**; this README intentionally does not assume a particular installed version.

```bash
bun install
codex login
claude auth login
```

Log in with each CLI's normal subscription flow. Flint does not require OpenAI or Anthropic API keys and removes common API credential variables before starting either child process.

## Run, test, and build

Start the API server, then start the Vite UI in another terminal:

```bash
bun run dev
bun run --filter @local-pair-review/web dev
```

The API listens only on `127.0.0.1:3000`; Vite proxies `/api` and `/ws` to it during development.

For the single-process production build, compile once and start the bundled Bun server. It serves the Vue SPA, API, and WebSocket from the same loopback origin:

```bash
bun run build
bun apps/server/dist/index.js
```

```bash
bun test
bun run test:e2e
bun run typecheck
bun run build
```

`bun run test:e2e` starts an isolated Bun server and Vite instance using the Fake Codex and Claude fixtures. It creates disposable Git repositories and does not contact either subscription service.

Verification status for this checkout: automated typecheck, Bun tests, Fake CLI browser E2E, and the production build pass. Bun `1.3.14` and Git `2.50.1 (Apple Git-155)` were verified. Real Codex and Claude smoke tests have **not** been executed because they require explicit user authorization; their CLI versions and results remain pending that authorization.

## Configuration and local data

By default, Flint stores SQLite data at `~/.local-pair-review/data/app.db`. Override it for a separate local instance:

```bash
LOCAL_PAIR_REVIEW_DATABASE=/absolute/path/to/data.sqlite bun run dev
```

The executable overrides must be absolute paths:

```bash
CODEX_EXECUTABLE=/absolute/path/to/codex
CLAUDE_EXECUTABLE=/absolute/path/to/claude
GIT_EXECUTABLE=/absolute/path/to/git
```

The same paths can be saved and rechecked from **CLI Settings**. UI overrides are validated as absolute paths and persisted in the local `app_settings` table; clearing a field restores the startup default. `LOCAL_PAIR_REVIEW_WEB_ROOT` may override the built `apps/web/dist` directory for packaging.

## Security and permissions

Flint is intentionally local-only. The server binds to loopback, rejects non-local browser requests, uses argument arrays with an explicit working directory for subprocesses, and never calls a shell command string or changes the process working directory.

Codex development starts with `--sandbox workspace-write` in the registered project directory. Claude review uses the CLI's `plan` permission mode and a narrow read-only tool allowlist; edit/write, destructive Git, commit, and push operations are denied at the CLI level. API credentials are stripped from child environments and diagnostic output is redacted before it is stored or displayed.

## Workflow

1. Register an absolute path to a local Git repository.
2. Create a focused task from the current `HEAD` baseline.
3. Start Codex development; Flint persists the exact Codex session ID as soon as it is emitted.
4. Start a read-only Claude review after development is ready.
5. Select or dismiss findings, add a human note, generate a feedback preview, and edit it if needed.
6. Explicitly send the edited feedback to resume that exact Codex session.
7. Run another review when wanted, or manually mark the task complete.

## MVP limits

Flint has no automatic Codex/Claude loop, users, remote access, worktrees, commits, pull requests, or pushes. It does not modify a repository except through the developer CLI you explicitly start. A stale review snapshot asks for confirmation before feedback can be sent. Interrupted and failed runs remain visible with a manual recovery path; no background retry silently consumes a subscription.

## Real CLI smoke tests

These commands are intentionally excluded from normal tests and CI:

```bash
bun run smoke:codex
bun run smoke:claude
```

Each command creates a dedicated temporary Git repository, prints the resolved executable path, detected version, authentication mode, and repository path, then waits for you to type the exact confirmation `RUN`. Until that confirmation is entered, no real subscription command runs. The Codex smoke test requires a visible Diff and performs an exact-ID resume only after the initial run supplies a session ID. The Claude smoke test validates the structured result and exact session ID, and proves the repository snapshot did not change under read-only permissions. Both remove only the temporary repository they created.
