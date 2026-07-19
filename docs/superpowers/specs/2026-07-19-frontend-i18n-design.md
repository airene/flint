# Frontend English and Chinese Localization

## Goal

Add English and Simplified Chinese UI localization with `vue-i18n`. English remains the default and fallback language.

## Scope

Localize Flint-controlled frontend copy: navigation, buttons, labels, statuses, empty states, confirmations, validation hints, and browser notifications. Preserve technical terms such as CLI, Developer, Reviewer, Task, Run, Git Diff, Session, provider names, model names, paths, and identifiers.

Do not translate Agent output, Activity raw content, repository content, persisted domain values, API contracts, or server-provided error messages.

## Design

Install `vue-i18n` and configure its Composition API with `legacy: false`, `locale: "en"`, and `fallbackLocale: "en"`. Keep typed English and `zh-CN` resources under `apps/web/src/i18n/`; English is the canonical key structure.

Persist only `en` or `zh-CN` in `localStorage` under `flint.locale`. Missing or invalid storage falls back to English. Locale changes update `document.documentElement.lang` immediately.

Add an icon-only language toggle beside the theme toggle. English shows `文` as the target language; Chinese shows `A`. The localized title and ARIA label describe the action.

Translate display helpers without changing stored enums. Dynamic technical values are interpolated unchanged. Frontend-owned fallback errors are translated; backend error text is displayed verbatim.

## Verification

- Unit tests cover default locale, persistence, invalid storage, switching, document language, and English fallback.
- Translation resources have matching keys.
- A focused E2E test switches to Chinese, verifies representative navigation and Task copy, reloads, and confirms persistence.
- Existing English E2E workflows remain valid by default.
- Run `bun test`, `bun run typecheck`, `bun run build`, focused E2E, and `git diff --check`.
