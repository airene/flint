# Flint Bilingual GitHub README Design

## Goal

Replace the current Chinese-first README with an attractive English GitHub landing page and a matching Chinese translation. The README should help two audiences quickly understand Flint:

1. Developers who need a local, human-controlled AI coding and code-review workflow.
2. Builders who want to study or create their own AI coding agent tools.

The copy should improve organic GitHub discovery without keyword stuffing or unsupported claims.

## Files

- Copy the current `README.md` unchanged to `docs/README_original.md` as a backup.
- Replace `README.md` with the English version.
- Add `README_CN.md` as the complete Simplified Chinese version.
- Link the English README to `README_CN.md` near the top, and link the Chinese README back to `README.md`.

## Positioning

Use a hybrid, value-first structure:

- Lead with the problem Flint solves: coordinating a writable Developer agent and an independent read-only Reviewer agent inside existing local Git repositories.
- Explain the human feedback gate, exact developer-session resume, local-first data model, and interchangeable Codex CLI / Claude Code roles.
- Include enough architecture and security detail to make the repository useful to AI coding tool builders.
- Naturally use relevant terms such as AI coding agent, local-first, multi-agent development, automated code review, Codex CLI, Claude Code, Bun, Vue, and TypeScript.

## README Structure

Both languages will follow the same information architecture:

1. Project title, concise tagline, and language switch.
2. Short project introduction and primary value proposition.
3. Key benefits and intended audiences.
4. Human-controlled Developer and Reviewer workflow.
5. Quick start with verified prerequisites and commands.
6. Architecture and technology stack.
7. Role configuration and local data settings.
8. Security and permission model.
9. Development, testing, production build, and optional real-CLI smoke tests.
10. Current limitations and license.

The first screen should remain concise. Detailed operational and security information will remain available below it instead of dominating the introduction.

## Accuracy Constraints

- Preserve the current Bun `>=1.3`, Git, Codex CLI, and Claude Code prerequisites.
- Keep `bun install`, `bun run dev`, production build, test, typecheck, E2E, and smoke-test commands accurate to `package.json`.
- State that at least one supported, authenticated CLI is required; both are needed for freely mixing providers across roles.
- Do not claim that real Codex or Claude smoke tests have passed.
- Do not add unsupported features, benchmarks, hosted-service claims, screenshots, badges requiring unknown repository metadata, or roadmap promises.
- Preserve the loopback-only, local SQLite, credential removal, Reviewer read-only, and human feedback-gate guarantees.

## Verification

- Confirm `docs/README_original.md` exactly matches the pre-edit `README.md`.
- Check reciprocal language links and all relative documentation links.
- Compare commands and runtime requirements against `package.json` and the current implementation.
- Search for stale product claims, accidental Chinese text in the English version, and accidental English prose in the Chinese version.
- Run Markdown-oriented whitespace checks with `git diff --check` and inspect the complete diff.

## Scope

This change is documentation-only. It does not alter application behavior, dependencies, tests, build configuration, or repository metadata. Changes remain uncommitted for user review.
