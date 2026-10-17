# Working on the Victor fork

Follow the [shared-fork workflow](docs/fork-workflow.md): squash feature/fix PRs, merge upstream-update PRs with a merge commit, and never rewrite shared main or release tags.

Read the adjacent [AGENTS.md](AGENTS.md). Follow its upstream guidance except where this file explicitly overrides it. Pi loads this file instead of that file, not in addition to it.

Before Victor work, read [docs/victor.md](docs/victor.md). Its source map distinguishes Victor responsibilities from shared Pi Pocket dependencies and identifies focused test coverage. Keep that map current rather than duplicating it here.

Keep temporary working plans in `.plans/`; do not commit them.

Keep all Victor and fork-maintenance scripts under `scripts/victor/` so they remain clearly separate from upstream tooling.

Keep Victor fork-specific tests directly under `test/` and name them `victor-<behavior>.test.ts`, including fork-maintenance tests (for example, `victor-fork-workflow.test.ts`). This keeps them distinct from upstream tests and included in automatic Victor test discovery.

## Upstream workflow review

Review the incoming workflow summary and diff printed by `just upstream-update` before merging. The fork's `Pages` workflow (`pages.yml`) is intentionally disabled through GitHub settings; prefer keeping upstream YAML unchanged when a workflow can simply remain disabled on the fork.

## Just recipes and scripts

Use **recipe** for a named entry in `justfile`, **command** for a shell invocation, and **script** for the implementation a recipe calls, such as `scripts/victor/fork.mjs`. Do not use “task” or “target” as synonyms for a Just recipe. Name the responsible layer when explaining argument parsing, validation, or errors.

Use native Just interfaces: explicit recipe parameters, comments for operations, `[arg('name', help='…')]` for input guidance, `just` for discovery, and `just --usage <recipe>` for syntax. Keep recipes thin and quiet. Scripts retain operational logic, input validation, and safety guards for direct calls and CI; reject unsupported option-like input before operational work. Keep detailed fork instructions in `docs/fork-workflow.md`. Test the actual Just entry point for listing, native usage, and argument forwarding, as well as the script's early rejection of invalid input.

## Validation

This policy replaces blanket validation and repository-wide formatting requirements in `AGENTS.md`, `docs/self-editing.md`, and `docs/architecture.md`, including full-suite requirements before completion or a restart. All other upstream safety rules still apply, including protecting live data and asking before a restart.

Choose checks by the behavior and dependencies affected, not merely whether a file is under `src/server/` or named `victor`.

### Isolated Victor changes

- Format changed files and lint changed code; do not run repository-wide formatting.
- Run focused tests for the changed behavior: `node --test test/<relevant>.test.ts`. For broader Victor coverage, use `node --test test/victor-*.test.ts`.
- Run `npm run check` for TypeScript changes.
- Immediately run `node --check` on each changed web JavaScript file.
- Documentation-only changes do not require code tests; check formatting and links.
- Do not run the full upstream suite by default.

### Shared integration changes

Use the boundaries and test coverage in [docs/victor.md](docs/victor.md#focused-test-coverage) to identify affected shared behavior and add its tests. That index is a starting point, not a complete list of dependencies or required checks.

A small Victor integration change does not automatically require the full suite. Use broader validation, including the full suite when warranted, for shared-core changes, cross-cutting dependency changes, upstream merges, or explicit requests.

Browser checks must use an isolated test server and disposable data. Automated checks do not establish physical-device audio reliability; report when relevant device testing remains outstanding.

## Test failures

- Check [TEST_ISSUES.md](TEST_ISSUES.md) for a matching error and release before blaming this change. A passing rerun alone proves neither an upstream issue nor a fix.
- Investigate unfamiliar failures; ask before unrelated fixes or costly upstream comparisons.
- Track useful failure signatures by release, never SHA. Add new issues, update evidence, and remove confirmed fixes; known repeats and rebases need no update.

Report checks run/skipped and remaining failures in the task summary.

## Maintaining these instructions

Keep `AGENTS.md` aligned with upstream; put fork-specific policy here. After upstream merges, review `AGENTS.md`, `docs/self-editing.md`, and `docs/architecture.md` for new guidance or conflicts with these exceptions.
