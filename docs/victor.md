# On-device Victor

Victor is an experimental, English-only conversation mode that recognizes speech and reads Pi's replies on your device. Only recognized text goes to Pi Pocket; audio stays local. Pi's replies still require a network connection. The ordinary dictation mic beside Send is separate and may use a browser-provided speech service.

## Setup

**Installation support:** Run this fork from a checkout using the setup below. Nix and NixOS packaging is retained from upstream but is not adapted or supported for this fork, including Victor's speech assets and fork-specific build checks.

On the server, prepare the pinned speech assets:

```sh
just prepare-victor
```

Without `just`, run `node scripts/victor/prepare-victor-assets.mjs` from the repository root. Assets are stored under ignored `vendor/victor/`. Rerunning preparation verifies existing assets and skips downloads when they are valid and unchanged; otherwise it rebuilds them.

`just start`, `just start-local`, and `just dev` prepare assets automatically. `just dev` uses Tailscale HTTPS port 8444 forwarding to loopback port 8788, with separate Pocket data under `~/.pi-pocket-dev` but the same host Pi authentication credentials and model configuration as regular Pi Pocket; see [development launch details](../README.md#https-with-tailscale-serve).

Open Pi Pocket over HTTPS (localhost also works) and allow microphone access. Keep the page visible and the phone unlocked. Safari on iPhone 13 Pro Max with iOS 27 or newer is the target, but physical-device audio and long-session reliability are not yet qualified.

## Using Victor

1. Open an idle main session, select a model, and clear the composer and message queue. You need permission to send and, when taking turns, the driving turn. Victor is unavailable in PiP and subagents.
2. Tap **Victor**. Wait for preparation and the rising recording cue before speaking.
3. End your message with **“send it”**. Victor removes that command and submits the text. Silence never sends.
4. The microphone stops while Pi works and reads its completed answer aloud, then listening resumes. Speaking over playback is not supported.

**Read reply** replays the latest answer while listening. **Speed** changes subsequent speech and is saved in this browser; the default is 1.25×.

Turn Victor off to stop local audio and return an unsent transcript to the composer. This does not stop Pi's shared run. Ordinary dictation is blocked until Victor is off.

Navigation, leaving the tab, connection loss, permission changes, or competing messages can stop Victor. If submission is uncertain, check the conversation before sending again; Victor does not automatically resubmit.

### Conversational replies

The **Victor reply style** extension is on by default. Its default instruction asks Pi to answer Victor messages conversationally in at most three short sentences, without headings, lists, tables, code blocks, or long URLs. It does not truncate answers or limit tool calls; the model must follow the instruction. The owner can replace the voice instruction with `/victor-style` or disable the extension in **Menu → Extensions** without disabling Victor's audio.

The style follows each submitted message, not the microphone's current state. Turning Victor off does not change an answer already underway. The next typed message, including ordinary dictation into the composer, restores normal style. A queued message changes style only when Pi takes it; a steering message changes it at the next request preparation after placement. PiP and subagents do not use the voice rule.

Victor sends `source: "victor"` with its text. The server records the source before submitting the input, keyed by the existing request ID, and retries keep the first recorded source. The extension reads the latest input placed in the active run, so the style survives tool calls, compaction, and server restarts. A new untagged message, including a scheduled message or subagent report, uses normal style. There is no separate server-side microphone toggle.

#### Configure the voice instruction

On a server running the integrated 0.14 API, the owner can use these native commands in an accessible conversation. They run without asking the model:

| Command                                 | Result                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `/victor-style` or `/victor-style show` | A transcript card marked **Default** or **Custom**, with the complete effective instruction. |
| `/victor-style set <instructions>`      | Replace the voice instruction across the whole Pocket instance.                              |
| `/victor-style reset`                   | Delete the override and restore the code default.                                            |

For example:

```text
/victor-style set This answer will be spoken aloud. Use brief, natural sentences and avoid visual formatting. These reply-style instructions do not limit tool calls or the work needed to answer correctly.
```

`set` takes all remaining text literally, trimming only outer whitespace. Internal spacing, newlines, quotes, backslashes, and apparent file paths are ordinary instruction text; there is no shell parsing, escape decoding, file loading, or flag syntax. The trimmed instruction may contain at most **3900 JavaScript string code units** (`.length`, not bytes or displayed characters). Pocket separately limits all command arguments to 4000 code units. Empty instructions, unknown actions, and extra arguments after `show` or `reset` are rejected without changing the setting.

For a long or multiline paste, type `/victor-style set ` first, then paste only the instruction after it. The existing composer can fold a long paste into a placeholder: if the entire command is inside that placeholder, Pocket sends it as chat instead of executing it. Before sending, check that the command hint says **not sent to Pi**. Long show cards offer **Show all … lines** to reveal the complete text.

The custom instruction **replaces**, rather than supplements, the default. Include any voice constraints you want to keep. Saving the current default explicitly still counts as Custom, so a later code-default change does not alter that choice. The normal-chat instruction stays fixed: it clears Victor's voice restrictions without imposing a style on ordinary conversations.

A successful save or reset gives a short private toast. Changes apply when the next Victor model request is prepared, across conversations, including subsequent tool rounds in an active run. They do not alter a provider request already prepared. Settings changes need no restart, source edit, or speech-asset preparation.

The override survives extension reloads and server restarts. Turning the extension off removes its command and prompt section but keeps the setting; re-enabling restores its use. A command already running may finish under its original module version, so disabling does not undo a committed setting. Concurrent writes take effect in commit order.

If a voice-settings read fails or a stored override is invalid, the extension warns and uses the default voice instruction, never an earlier custom instruction. `show` identifies invalid stored values as falling back to Default; a failed command read or write reports failure instead of success. Source-attribution lookup failures still use the normal-chat reset to avoid leaving voice restrictions active.

Only the owner can invoke this global command; guests, session-limited guests, and viewers cannot. While someone else drives a conversation, the owner can use another accessible conversation. **A show card is visible to everyone who can read that conversation and appears in export and search.** Use an owner-only conversation when that matters. These settings are not a secret store: command arguments and results remain in durable task data, and the effective instruction goes to the model provider. Put no secrets in instructions.

## Downloads and caching

First activation downloads about **149 MB**. Do this on Wi-Fi using the same browser and stable HTTPS address you will use later. Different addresses or browser profiles do not share downloads; changing a quick-tunnel hostname requires another download.

Later activations reuse cached assets but still take time to initialize. Updates may require a fresh download. Browser storage eviction or clearing site data also removes cached models. Victor is not an offline app.

## Updates

Preparation installs the versions pinned in `victor-sources.json`; it does not choose newer models automatically. Model changes need compatibility testing before use.

After installing an update that changes Victor's server code or assets:

1. Turn Victor off on connected clients.
2. Run `just prepare-victor` in the serving checkout.
3. Have the owner use **Menu → Restart server**, then reload clients before activating Victor.

To roll back, restore the previous source/code and repeat these steps. Retained asset directories alone are not a rollback.

## Troubleshooting

- **Assets unavailable / HTTP 503:** rerun preparation on the server. After repair, restart and reload as above. Ordinary chat remains available.
- **Interrupted download:** activate Victor again on a stable connection; completed cached downloads can be reused.
- **Checksum error:** rerun preparation, then delete the affected `pocket-victor-…` cache in browser developer tools and reload. To force a server rebuild, delete `vendor/victor/.prepared.json` before preparing again.
- **Audio failure or stuck mode:** turn Victor off and on. Check microphone permission, HTTPS, and that the page is visible. Check the conversation before repeating a message.

## Maintaining the fork

See [the fork workflow](fork-workflow.md) for shared-main collaboration: squash feature PRs, preserve upstream-update merges, check changes, and tag tested releases. These repository operations are separate from preparing assets and restarting a running app.

## Source files

Use this map to locate the behavior being changed, identify boundaries it crosses, and choose [focused tests](#focused-test-coverage). The source and tests remain the authority for implementation details. Paths are relative to the repository root.

### Victor code and tooling

All Victor and fork-maintenance scripts live under `scripts/victor/`, separate from upstream tooling.

| File                                                                                            | Responsibility and boundary                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`web/victor-mode.js`](../web/victor-mode.js)                                                   | Owns activation, the separate speech draft, send-command finalization, reply attribution, and capture/playback teardown. Submits text tagged as Victor input without automatically retrying uncertain delivery; stopping Victor never stops Pi's shared run.                                                |
| [`web/victor-controls.js`](../web/victor-controls.js)                                           | Renders controller state, the speech draft, replay, and speed controls. Audio and conversation ownership stay in the controller; activation and typed-draft protection also involve `composer.js`.                                                                                                          |
| [`web/victor-worker.js`](../web/victor-worker.js)                                               | Loads models and runs recognition and synthesis in one WebAssembly runtime per activation. Owns recognition streams, decoded-audio acknowledgments, pronunciation-pack verification, and generated audio; its message protocol must stay aligned with the controller.                                       |
| [`web/victor-capture-worklet.js`](../web/victor-capture-worklet.js)                             | Converts microphone channels to mono batches without playing them back. Bounds unacknowledged audio; flushing preserves the final batch while stopping discards it. Changes must preserve controller/worker acknowledgment and flush ordering.                                                              |
| [`web/victor-cache.js`](../web/victor-cache.js)                                                 | Handles same-origin, versioned asset GETs for `sw.js`, not manifests or app data. Preserves completed downloads, retires other Victor caches, and falls back to the network on storage failures.                                                                                                            |
| [`web/victor.css`](../web/victor.css)                                                           | Styles Victor controls, draft, errors, and the active composer. Also adjusts neighboring composer controls on narrow screens; check those interactions with `composer.js` and shared `style.css`.                                                                                                           |
| [`src/server/extensions/victor-reply-style.ts`](../src/server/extensions/victor-reply-style.ts) | Owns the instance-wide durable voice override and owner-only `/victor-style` command; renders custom/default voice instructions or the fixed normal-chat reset. Independently switchable in Extensions.                                                                                                     |
| [`src/server/victor-replies.ts`](../src/server/victor-replies.ts)                               | Records immutable input sources before admission and resolves the latest placed input of an active main-session run.                                                                                                                                                                                        |
| [`src/server/http/victor-assets.ts`](../src/server/http/victor-assets.ts)                       | Validates and serves the generated manifest and allowlisted immutable assets; defines speech-script security policies. Keeps the first valid manifest until restart. Missing assets must not prevent ordinary app startup.                                                                                  |
| [`victor-sources.json`](../victor-sources.json)                                                 | Editable download pins, archive-member mappings, and speech configuration. This is preparation input, not the browser manifest. Changes must agree with the preparation script, server validation, and worker's supported configuration.                                                                    |
| [`scripts/victor/prepare-victor-assets.mjs`](../scripts/victor/prepare-victor-assets.mjs)       | Verifies archives, rejects unsafe layouts, packs pronunciation files, and builds `vendor/victor/`. Reuses output only after verification and publishes the manifest last, preserving the current manifest if preparation fails.                                                                             |
| [`justfile`](../justfile)                                                                       | Groups run, Tailscale, and shared-fork operations. Launch recipes prepare assets; `start` uses HTTPS port 8443, while `dev` uses port 8444, separate Pocket data, shared host Pi credentials and model configuration, and a browser-profile warning. These are not disposable scripted-model test servers.  |
| [`scripts/victor/fork.mjs`](../scripts/victor/fork.mjs)                                         | Implements upstream-refreshed status and fork history, shared-main guards, user-namespaced feature branches from fetched fork main, upstream-update merges, confirmed branch publication and prefixed PR creation, focused checks, and immutable release-tag publishing. Never merges PRs or rewrites main. |
| [`scripts/victor/check-pr-title.mjs`](../scripts/victor/check-pr-title.mjs)                     | Validates PR title prefixes against the head branch for the [`Fork checks` workflow](../.github/workflows/fork-checks.yml). Reads event metadata only; never renames commits or upstream history.                                                                                                           |
| [`test/victor-input.js`](../test/victor-input.js)                                               | Supplies recorded microphone input and observes submissions, generated audio, playback, and teardown in an isolated `test/serve.ts` session. Keeps both speech engines real; observations are not automatic assertions or proof of audible device output.                                                   |

### Shared Pi Pocket dependencies

These are integration hooks and shared dependencies, not files owned exclusively by Victor or a list of fork edits. Before changing shared behavior, inspect its other callers and tests. General application dependencies are omitted.

| File                                                                                                                                       | Victor dependency and shared behavior to preserve                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`web/composer.js`](../web/composer.js)                                                                                                    | Mounts controls, guards typed drafts, attachments, and pending sends, and restores unsent speech to its original conversation. Preserve ordinary send/steer/queue, commands, attachments, and draft insertion without losing either draft.                                                                         |
| [`web/voice.js`](../web/voice.js)                                                                                                          | Gives Victor exclusive audio ownership across dictation boxes, including PiP and Alt+V, until Victor is off. Preserve caret-aware dictation, typed text, cancellation of late results, and PiP shortcut priority.                                                                                                  |
| [`web/store.js`](../web/store.js)                                                                                                          | Supplies connection, conversation, attribution, and queue state, per-conversation drafts, and API calls. Preserve incremental view merging, draft isolation, and HTTP error statuses used to distinguish rejected submissions from uncertain delivery.                                                             |
| [`web/ui.js`](../web/ui.js)                                                                                                                | Supplies UI helpers and `replyText`, which excludes thinking and tool calls and also serves ordinary reply actions. Keep speech-specific cleanup in `victor-mode.js`, not shared reply extraction or Markdown rendering.                                                                                           |
| [`web/app.js`](../web/app.js)                                                                                                              | Starts shared service-worker registration. Keep it independent of notification support and non-blocking for normal app startup, badge updates, and incoming shares.                                                                                                                                                |
| [`web/service-worker.js`](../web/service-worker.js)                                                                                        | Shares one registration between app startup, notifications, and Victor; bounds Victor's first-install wait for page control. Preserve operation without push permission, unsupported-browser fallbacks, and timeout/listener cleanup.                                                                              |
| [`web/notify.js`](../web/notify.js)                                                                                                        | Uses shared worker registration while keeping notification capability and permission checks separate. Victor caching must work without push support; preserve notification subscriptions, preferences, and badge behavior.                                                                                         |
| [`web/sw.js`](../web/sw.js)                                                                                                                | Dispatches versioned asset requests to the Victor cache helper. Preserve push display, approval actions, notification navigation, PiP opening, and share-target handling; app/API requests must stay outside the Victor cache and share handling must take precedence.                                             |
| [`web/index.html`](../web/index.html)                                                                                                      | Imports `victor.css` after shared styles in the `pocket` cascade layer so themes can override both. Preserve the app entry point, local import map, theme-before-paint script, and mobile/home-screen metadata.                                                                                                    |
| [`web/style.css`](../web/style.css)                                                                                                        | Supplies theme variables, controls, focus states, and composer layout. Keep Victor-specific overrides in `victor.css`; shared changes also affect ordinary composers, touch targets, and iOS field sizing.                                                                                                         |
| [`src/server/http.ts`](../src/server/http.ts)                                                                                              | Routes `/victor-assets/` to the optional asset handler. Preserve API, authentication, artifact, share-fallback, and static routes; missing Victor assets must not prevent ordinary app use.                                                                                                                        |
| [`src/server/http/assets.ts`](../src/server/http/assets.ts)                                                                                | Allows WebAssembly in the app policy and applies dedicated security headers to Victor worker/worklet scripts. Preserve same-origin restrictions, inline-script hashes, and app-file revalidation (`no-cache`); do not broaden ordinary JavaScript evaluation permissions.                                          |
| [`src/server/http/conversation-routes.ts`](../src/server/http/conversation-routes.ts)                                                      | Accepts Victor text through the ordinary submit endpoint, validating text/request IDs and filtering attachment paths. Preserve validation for every client; there is no separate Victor submission route.                                                                                                          |
| [`src/server/docs.ts`](../src/server/docs.ts)                                                                                              | Defines the per-request `InputSourceDoc` family; existing document kinds and semantics stay unchanged.                                                                                                                                                                                                             |
| [`src/server/host.ts`](../src/server/host.ts), [`src/server/app.ts`](../src/server/app.ts)                                                 | Expose the read-only `victorReplyMode` host method; extensions do not access `PocketApp` directly.                                                                                                                                                                                                                 |
| [`src/server/extension-commands.ts`](../src/server/extension-commands.ts), [`src/server/extension-web.ts`](../src/server/extension-web.ts) | Register and dispatch the owner-only global style command, including authorization, durable runs, retry deduplication, transcript cards, and private toasts. Keep these shared semantics in Pocket, not Victor.                                                                                                    |
| [`src/server/reload.ts`](../src/server/reload.ts)                                                                                          | Registers the built-in Victor reply-style extension and its title. Preserve existing extension order and switches.                                                                                                                                                                                                 |
| [`src/server/commands.ts`](../src/server/commands.ts)                                                                                      | Applies existing access, driving-turn, model, spend, attribution, request-ID, and queue rules to submitted text. Validates the optional Victor source and records it before admission. Preserve typed-message command expansion and attachments; Victor's plain-text restrictions belong in its client controller. |

### Focused test coverage

This is a starting point for selecting tests by affected behavior, not a requirement to run every listed suite. Changes to a shared contract also need its upstream tests. Keep failure signatures and their baseline evidence in [TEST_ISSUES.md](../TEST_ISSUES.md), not in this map.

[`victor-just-interface.test.ts`](../test/victor-just-interface.test.ts) checks listings, native usage, argument forwarding, and rejection of unsupported options before Git or GitHub run, using disposable fixtures. It requires Just on `PATH` (`mise install just`); CI installs the latest release.

| Behavior                                                                                                          | Tests to inspect                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared-main guards, upstream merge ancestry, PR publication, release tagging, and failed-operation safety         | [`victor-fork-workflow.test.ts`](../test/victor-fork-workflow.test.ts), using disposable local repositories and remotes.                                                                                                                                                                                                                          |
| PR title prefixes and invalid PR metadata                                                                         | [`victor-fork-pr-title.test.ts`](../test/victor-fork-pr-title.test.ts).                                                                                                                                                                                                                                                                           |
| Per-input response style, switching, queues, steering, retries, compaction, restart, scope, and source validation | [`victor-reply-style.test.ts`](../test/victor-reply-style.test.ts). Shared submission and extension regression coverage: [`app.test.ts`](../test/app.test.ts), [`sessions.test.ts`](../test/sessions.test.ts), [`prompts.test.ts`](../test/prompts.test.ts), [`dropins.test.ts`](../test/dropins.test.ts).                                        |
| Durable voice configuration, command parsing/access, next-request timing, persistence, and failure fallback       | [`victor-extension-config.test.ts`](../test/victor-extension-config.test.ts). Shared command and loader coverage: [`extension-commands.test.ts`](../test/extension-commands.test.ts), [`extension-loader.test.ts`](../test/extension-loader.test.ts), [`prompts.test.ts`](../test/prompts.test.ts), [`dropins.test.ts`](../test/dropins.test.ts). |
| Controller lifecycle, draft ownership, reply attribution, cues, replay, and send-command finalization             | [`victor-mode.test.ts`](../test/victor-mode.test.ts), [`victor-listening.test.ts`](../test/victor-listening.test.ts).                                                                                                                                                                                                                             |
| Worker initialization, recognition/synthesis protocol, pronunciation-pack validation, and runtime failures        | [`victor-worker.test.ts`](../test/victor-worker.test.ts).                                                                                                                                                                                                                                                                                         |
| Source pins, deterministic preparation, unsafe archives, verification, and repair                                 | [`victor-assets.test.ts`](../test/victor-assets.test.ts).                                                                                                                                                                                                                                                                                         |
| Manifest/asset serving and security headers                                                                       | [`victor-http.test.ts`](../test/victor-http.test.ts); production-routing cases in [`victor-composer-ui.test.ts`](../test/victor-composer-ui.test.ts). For shared HTTP behavior, inspect the web-edge cases in [`app.test.ts`](../test/app.test.ts).                                                                                               |
| Composer draft/attachment guards, navigation, and responsive controls                                             | [`victor-composer-ui.test.ts`](../test/victor-composer-ui.test.ts); [`mobile-ui.test.ts`](../test/mobile-ui.test.ts) when changing shared layout or interaction.                                                                                                                                                                                  |
| Cache selection, failures, cleanup, interrupted downloads, and browser persistence                                | [`victor-cache.test.ts`](../test/victor-cache.test.ts), [`victor-cache-ui.test.ts`](../test/victor-cache-ui.test.ts).                                                                                                                                                                                                                             |
| Ordinary dictation and Victor's exclusive audio ownership                                                         | [`voice.test.ts`](../test/voice.test.ts), plus controller lifecycle cases in [`victor-mode.test.ts`](../test/victor-mode.test.ts).                                                                                                                                                                                                                |
| Shared worker registration, first-install waiting, and notification capability checks                             | [`service-worker.test.ts`](../test/service-worker.test.ts), [`notify.test.ts`](../test/notify.test.ts). These do not fully cover notification clicks or incoming-share workflows.                                                                                                                                                                 |

Controller and worker unit tests use stand-ins, and browser tests use synthetic speech or small asset fixtures. Worklet changes need explicit checks of sample batching, queue limits, and acknowledgment/flush ordering: controller tests simulate the worklet rather than exercising its processor. These suites do not establish model compatibility, physical-device audio quality, or long-session reliability; the recorded-input observer and target-device checks serve different purposes.
