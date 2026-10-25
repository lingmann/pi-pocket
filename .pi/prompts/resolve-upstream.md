---
description: Resolve an upstream Pi Pocket merge while preserving Victor
argument-hint: "[release or additional focus]"
---

Review the upstream changelog, then resolve the merge in progress while preserving Victor's complete feature set.

Release or focus: ${@:-Infer from the current merge.}

- Follow `AGENTS.override.md`, `docs/victor.md`, and `docs/fork-workflow.md` rather than duplicating their rules.
- Check automatically merged code for Victor regressions, not just conflict markers. Preserve upstream improvements with small, maintainable fork-specific changes; avoid unrelated fixes and new abstractions.
- Validate the affected behavior under the repository's test policy. Check failures against `TEST_ISSUES.md`; do not assume they are upstream issues.
- Preserve unrelated work. Leave the resolutions staged; do not commit, publish, or restart unless asked.
- Briefly report important release changes, integration fixes, checks, and remaining risks.
