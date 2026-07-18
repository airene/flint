# File Mentions in Agent Prompts

## Goal

Support `@file` autocomplete in the new-task prompt and the Continue Developer input. Selecting a file inserts only its repository-relative path; the agent reads the file later if needed.

Candidates include Git-tracked files and untracked files not excluded by `.gitignore`. Feedback editing is out of scope.

## Design

Add `GET /api/projects/:projectId/files?q=<query>&limit=50`. The query defaults to empty and is limited to 200 characters; `limit` defaults to 50 and must be between 1 and 50. After validating the project, the server runs `git ls-files --cached --others --exclude-standard -z`, filters paths in memory, and returns `{ files: string[] }`. Ranking is case-insensitive: filename-prefix matches first, then path-segment prefixes, then path substrings; ties use shorter paths and lexical order.

The search term is never passed to Git. Query length is bounded, results are capped at 50, and paths containing control characters are excluded. A five-second per-project cache avoids rerunning Git for each keystroke.

Create a reusable `FileMentionInput.vue` with multiline and single-line modes. Keep mention parsing and text replacement in a pure `file-mention.ts` helper. Both modes accept `projectId` and preserve their existing value/update interfaces.

Typing `@` at the beginning of text or after whitespace or an opening bracket opens a menu below the input. The component debounces search by about 150 ms and cancels stale requests. Arrow keys move through results; Enter or Tab selects; Escape closes. With the menu closed, Enter keeps its existing behavior: newline for the task prompt and submit for Continue Developer. IME composition must not be intercepted.

Selecting a normal path inserts `@src/example.ts `; paths containing spaces use `@"docs/design notes.md" `. Selection replaces only the active mention at the caret, including when editing in the middle of existing text. Loading, empty, and failure states remain non-blocking. The menu uses `listbox` and `option` accessibility semantics.

The existing task request and database models do not change: the inserted path remains ordinary prompt text.

## Verification

- Git service tests cover tracked, untracked, ignored, ranked, limited, and unsafe paths.
- Contract and API tests cover validation, missing projects, URL encoding, and response parsing.
- Pure helper tests cover trigger detection, email-like text, cursor position, replacement, and quoted paths.
- End-to-end tests cover keyboard selection in both inputs and unchanged Enter behavior.
- Run `bun test`, `bun run typecheck`, and the web build.
