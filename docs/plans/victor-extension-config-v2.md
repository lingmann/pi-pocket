# Victor extension configuration v2

Status: implementation plan, to begin after upstream 0.14.0 is integrated and validated in this fork. No runtime changes are part of this document.

Start directly with a durable setting and an owner-only extension command. No file-based configuration was implemented, so there is no configuration-file migration to build.

## Goal and scope

Let the owner show, replace, and reset Victor's voice-reply instruction without editing source or asking the model to change settings.

- One setting applies across the Pocket instance.
- The current `VOICE` instruction remains the exact default.
- The normal-chat `TEXT` instruction stays fixed: it clears voice restrictions rather than defining ordinary chat style.
- The existing Extensions toggle remains the enable/disable control.
- Existing input-source attribution, audio behavior, and PiP/subagent exclusions remain unchanged.

The setting changes instructions sent to the model; it does not enforce sentence counts or truncate responses.

## Starting point and prerequisites

1. Complete the upstream merge separately, following the [shared-fork workflow](../fork-workflow.md), including validation appropriate to that merge. Do not bundle upstream integration into this feature.
2. Confirm the integrated version supplies `web.command`, global command authorization, `ctx.snapshot`, and `ctx.commit`.
3. Re-read the integrated clock example, command guide, command limits, and extension types before implementation. References inspected for this plan:
    - [Clock settings example](https://github.com/TannerMidd/pi-pocket/blob/v0.14.0/docs/examples/clock.ts).
    - [Slash commands](https://github.com/TannerMidd/pi-pocket/blob/v0.14.0/docs/extensions/commands.md).
    - [Command context](https://github.com/TannerMidd/pi-pocket/blob/v0.14.0/docs/extensions/reference/command-context.md).
    - [Limits](https://github.com/TannerMidd/pi-pocket/blob/v0.14.0/docs/extensions/reference/limits.md#commands).
4. Keep Victor as a built-in fork extension. Its `host.victorReplyMode` dependency is fork-specific; this work does not turn it into a portable drop-in.

Use the integrated built-in host/web types and conventions. Do not backport commands or add support for operating this feature on pre-0.14 servers. Preserve the existing source-mode host guard, and follow upstream's feature-detection guidance for modules that can hot-reload against a server not yet restarted; omit command registration safely if `web.command` is unavailable. This is a loading safeguard, not an alternative settings implementation.

## User-facing command

Register `victor-style` with `scope: "global"`, a short description, and an argument hint `"[show | set <instructions> | reset]"`.

| Invocation                         | Result                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `/victor-style`                    | Same as `show`.                                                                            |
| `/victor-style show`               | Show whether the default or an override is active, and the complete effective instruction. |
| `/victor-style set <instructions>` | Validate and save a replacement voice instruction.                                         |
| `/victor-style reset`              | Delete the override, restoring the code default.                                           |

### Parsing and validation

- Parse only the first whitespace-delimited action. For `set`, treat the entire remaining text as the instruction, trim its outer whitespace, and preserve internal spacing and newlines.
- Do not shell-parse arguments, interpret quotes, decode escapes, read file paths, or introduce flags. Quotes typed by the owner are literal instruction text.
- Reject unknown actions, extra arguments to `show` or `reset`, and empty or whitespace-only `set` values with `web.error(400, ...)` and concise usage guidance.
- Limit the trimmed instruction to 3900 JavaScript string code units, measured with `.length`. This leaves room for `set ` within 0.14's 4000-character command-argument limit. Document this limit accurately; do not call it bytes or promise 3900 Unicode graphemes.
- Use the same content validation when reading stored overrides. A missing field is normal; an invalid present field is an error with a fallback.
- Do not silently truncate accepted instructions or sanitize them as untrusted quoted data: the owner is deliberately authoring a prompt instruction.

### Results and access

Use a transcript card for `show`, because 0.14 truncates toast messages at 500 characters. The card states `Default` or `Custom` and includes the complete instruction as plain text. An invalid stored value should be identified as falling back to the default, not reported as a valid custom setting.

Use short private toasts for successful `set` and `reset`, without echoing the instruction. Confirm that changes apply to subsequent Victor requests across the instance.

Global command authorization belongs to Pocket's command dispatcher. Test it through the real entry point: guests, session-limited guests, and viewers cannot execute the command, including direct requests. Do not weaken the scope to make the command available in more message boxes. An owner who cannot type while someone else drives can use another accessible conversation.

`show` is owner-only to invoke, but its card is visible to everyone who can read that conversation and appears in export/search. Document using an owner-only conversation when that matters. The settings are not a secret store: command arguments/results are durable task data and the effective voice instruction goes to the model provider. No model request is made merely to run the command.

## Storage and defaults

Define the document in [the extension module](../../src/server/extensions/victor-reply-style.ts), not Pocket's central `docs.ts`:

```ts
const ReplySettings = defineDoc<{ voiceInstruction?: string }>({
    kind: "x.victor-reply-style.settings",
    version: 1,
    scope: "session",
    initial: () => ({}),
});
```

Pi Durable's `"session"` scope refers here to the shared storage session, encompassing the whole Pocket instance. It is not `"conversation"`, which would make the setting specific to one chat. Do not supply a conversation id when accessing this singleton:

- Command read: `ctx.snapshot(ReplySettings, ctx.context)`.
- Command write: `ctx.commit(async (tx) => { ... await tx.doc(ReplySettings) ... })`.
- Section read: `input.read.snapshot(ReplySettings, context)`.

Store only an explicit override. A missing document or field uses `VOICE`; do not write defaults during startup, rendering, or `show`. Reset deletes `voiceInstruction`; an empty document after reset is acceptable. An explicitly saved value equal to today's default remains an explicit override, so a later code-default change does not silently change the owner's choice.

Validate before committing. Change the field in one transaction; do not keep a mutable settings cache. Concurrent writes follow commit order, with the last committed operation taking effect. A confirmation follows a successful commit, never precedes it. A failed save must not claim success or change the effective value in memory.

Keep document kind, scope, and field meanings stable once deployed. No new host accessor, core config field, JSON file, dependency, or database access outside Pi Durable is needed.

## Prompt integration and failures

Keep the renderer's source-mode decision separate from configuration lookup:

1. Preserve the existing old-host guard for `victorReplyMode`.
2. Resolve mode through `host.victorReplyMode` as today.
3. For excluded conversations, return `undefined` without reading settings.
4. For normal text mode, return the fixed `TEXT` without reading settings.
5. For Victor mode, read the settings document and return its valid override or `VOICE`.

Return stable text while mode and settings are unchanged. Do not add timestamps, counters, or settings status to the model's prompt.

- Source lookup failure: preserve the existing warning and `TEXT` fallback, preventing a previous voice section from remaining active.
- Configuration read or validation failure after Victor mode is established: warn through `host.notice` and return `VOICE`, not `TEXT` or the previous custom instruction.
- Do not include the custom instruction in warning messages.
- Cancellation: propagate it rather than warning and selecting a fallback.
- Command read/write failures: let the command framework report failure; do not report a successful save/reset or hide a failed `show` read behind a normal status.

Changes apply when the next model request is prepared, including subsequent tool rounds in an active run. They do not alter a provider request already prepared. No setting snapshot is attached to submitted messages: only input source retains its existing per-run attribution.

Turning the extension off removes its command and prompt section through the existing loader. Preserve stored preferences while disabled. Re-enabling or restarting restores their use. A command already running may finish under its original module version, as upstream documents; do not promise that disabling undoes a committed setting.

## Implementation sequence and files

### 1. Implement storage, command, and renderer together

Change `src/server/extensions/victor-reply-style.ts`:

- Add the singleton and the small validation/parser logic needed for this one setting.
- Accept the module's `web` argument and register the global command.
- Keep the default voice and normal-chat instruction constants unchanged.
- Read the override only in the Victor branch, with the failure handling above.
- Update the module description to mention owner configuration.

Keep this logic in the module. Do not build a generic settings framework or separate service. Check every caller of the module factory and update its test arguments for the integrated API.

### 2. Add focused tests

Add `test/victor-extension-config.test.ts` directly under `test/`, following the integrated `test/extension-commands.test.ts` fixtures and real command-dispatch path. Extend [victor-reply-style.test.ts](../../test/victor-reply-style.test.ts) only where existing renderer mocks or attribution regression assertions need adjustment. Avoid two suites duplicating the same configuration scenarios.

Use scripted models and disposable Pocket data directories. Cover:

- Missing settings preserve the exact current default; `show` and rendering create no settings document.
- Show/default, set, show/custom, and reset work through real command execution without invoking the model.
- Full-length show output uses a card without toast truncation; save/reset toasts do not echo the instruction.
- Literal quotes and multiline instructions are preserved apart from outer whitespace.
- Empty values, unknown actions, trailing arguments on show/reset, and length boundaries are validated; invalid writes leave the previous setting unchanged. Include the framework's overall argument limit.
- Guest, session-limited guest, and viewer calls are rejected and cannot mutate preferences.
- A valid override replaces rather than supplements `VOICE`, applies across two main conversations, and remains isolated from another Pocket instance.
- A committed change reaches the next request without reloading the extension, including a controlled tool-round continuation. Identical settings yield identical section text.
- Settings survive module reload and app reopen; disabling removes command availability, does not delete settings, and re-enabling restores them.
- Reset removes the field and restores the code default. Saving the default explicitly remains an override.
- Typed input still gets the fixed reset after a custom Victor reply; existing queue, steering, retry, compaction, PiP, and subagent coverage stays intact.
- Invalid stored values and failed reads fall back to `VOICE`, never a stale custom section. Use a narrow fixture/mock for read errors rather than corrupting a live database.
- Source lookup failure still returns `TEXT`; cancellation propagates in source and settings paths.
- A rejected commit produces no success result and leaves stored state unchanged. Repeated delivery with the same command request id uses the command framework's existing result rather than reapplying an older setting after a newer change.

Use the upstream transaction and command lifecycle semantics rather than adding application-specific retry or deduplication machinery.

### 3. Document the feature

Update [docs/victor.md](../victor.md):

- Explain instance-wide owner configuration, default/custom/reset behavior, command syntax, literal text parsing, and the length limit.
- Include a short replacement-instruction example that identifies spoken output and distinguishes reply style from tool work.
- Explain next-request timing, behavior while disabled, persistence, and failure fallback.
- Explain show-card visibility and command-data retention; instructions must contain no secrets.
- Keep the normal-chat reset fixed and explain why.
- Update the existing source map and focused-test table rather than creating a second responsibility map.

Do not change core HTTP endpoints, config storage, input attribution, extension ordering, or browser files. If an integration requirement unexpectedly demands one of these, explain why and revise scope before implementing it.

## Validation and completion

Validate the upstream merge separately before starting. For this feature:

1. Format changed files only and lint changed TypeScript.
2. Run `npm run check` using the integrated 0.14 scripts.
3. Run `node --test test/victor-extension-config.test.ts test/victor-reply-style.test.ts`.
4. Run affected shared tests: `node --test test/extension-commands.test.ts test/prompts.test.ts test/dropins.test.ts test/extension-loader.test.ts`. Confirm these names against the integrated checkout.
5. Check documentation formatting and relative links.
6. On an isolated disposable test server, smoke-test command suggestions, set/show/reset, a multiline paste, and full show-card rendering. Use a scripted model, not live provider credentials or production data. No new browser UI is planned, but the existing composer is the configuration entry point.

Consult [TEST_ISSUES.md](../../TEST_ISSUES.md) for matching failures and report checks run, skipped, and unresolved. The feature alone does not call for a full upstream suite by default. Audio assets and physical-device audio testing are outside this change; automated prompt tests do not prove model compliance with a custom instruction.

Deploy only after the server runs the integrated API. Ask before restarting any serving instance. Subsequent settings changes require no restart, source edit, or asset preparation.

Done means the owner can show, set, and reset a durable instance-wide override through native commands; defaults and normal chat remain unchanged; unauthorized writes are rejected; reload/restart preserve the setting; and the focused checks pass.

## Explicit non-goals

- Instruction files, file readers/watchers, or migration/import commands.
- Configuration in `config.json`, Pi's settings, environment variables, or browser storage.
- Per-user, per-project, per-conversation, or per-browser overrides.
- Editable normal-chat reset text or separate sentence/formatting controls.
- A settings sheet, custom route, browser module, or model-facing settings tool.
- Changes to speech assets, microphone lifecycle, playback speed, source attribution, or hard response limits.
- Pre-0.14 feature support or a generic extension configuration API.
