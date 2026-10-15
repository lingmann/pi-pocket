# On-device Victor

Victor is an experimental, English-only conversation mode that recognizes speech and reads Pi's replies on your device. Only recognized text goes to Pi Pocket; audio stays local. Pi's replies still require a network connection. The ordinary dictation mic beside Send is separate and may use a browser-provided speech service.

## Setup

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

### Reply style

The **Victor reply style** extension is on by default. It asks Pi to reply conversationally in at most
three short sentences, without headings, lists, tables, or code blocks. This is a model instruction,
not a hard output limit. The owner can turn it off in **Menu → Extensions**.

Style follows the submitted message, not whether a browser currently has Victor open. An accepted
Victor message keeps voice guidance through tool calls and server restarts, even if you turn Victor
off while Pi works. The next typed message or ordinary dictation gets normal guidance. Switching
Victor on and off sends no extra messages and does not change the session's standing instructions.
A queued message changes the style only when admitted to the run; the newest admitted input, including
a steering message, determines the next model request's style. An answer already streaming is unchanged.

The [MVP plan](victor-reply-style-plan.md) describes the metadata, recovery, and validation design.

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

| File                                                                                      | Responsibility and boundary                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`web/victor-mode.js`](../web/victor-mode.js)                                             | Owns activation, the separate speech draft, send-command finalization, reply attribution, and capture/playback teardown. Submits text tagged `inputSource: "victor"` without automatically retrying uncertain delivery; stopping Victor never stops Pi's shared run.                                        |
| [`web/victor-controls.js`](../web/victor-controls.js)                                     | Renders controller state, the speech draft, replay, and speed controls. Audio and conversation ownership stay in the controller; activation and typed-draft protection also involve `composer.js`.                                                                                                          |
| [`web/victor-worker.js`](../web/victor-worker.js)                                         | Loads models and runs recognition and synthesis in one WebAssembly runtime per activation. Owns recognition streams, decoded-audio acknowledgments, pronunciation-pack verification, and generated audio; its message protocol must stay aligned with the controller.                                       |
| [`web/victor-capture-worklet.js`](../web/victor-capture-worklet.js)                       | Converts microphone channels to mono batches without playing them back. Bounds unacknowledged audio; flushing preserves the final batch while stopping discards it. Changes must preserve controller/worker acknowledgment and flush ordering.                                                              |
| [`web/victor-cache.js`](../web/victor-cache.js)                                           | Handles same-origin, versioned asset GETs for `sw.js`, not manifests or app data. Preserves completed downloads, retires other Victor caches, and falls back to the network on storage failures.                                                                                                            |
| [`web/victor.css`](../web/victor.css)                                                     | Styles Victor controls, draft, errors, and the active composer. Also adjusts neighboring composer controls on narrow screens; check those interactions with `composer.js` and shared `style.css`.                                                                                                           |
| [`src/server/http/victor-assets.ts`](../src/server/http/victor-assets.ts)                 | Validates and serves the generated manifest and allowlisted immutable assets; defines speech-script security policies. Keeps the first valid manifest until restart. Missing assets must not prevent ordinary app startup.                                                                                  |
| [`victor-sources.json`](../victor-sources.json)                                           | Editable download pins, archive-member mappings, and speech configuration. This is preparation input, not the browser manifest. Changes must agree with the preparation script, server validation, and worker's supported configuration.                                                                    |
| [`scripts/victor/prepare-victor-assets.mjs`](../scripts/victor/prepare-victor-assets.mjs) | Verifies archives, rejects unsafe layouts, packs pronunciation files, and builds `vendor/victor/`. Reuses output only after verification and publishes the manifest last, preserving the current manifest if preparation fails.                                                                             |
| [`justfile`](../justfile)                                                                 | Groups run, Tailscale, and shared-fork operations. Launch recipes prepare assets; `start` uses HTTPS port 8443, while `dev` uses port 8444, separate Pocket data, shared host Pi credentials and model configuration, and a browser-profile warning. These are not disposable scripted-model test servers.  |
| [`scripts/victor/fork.mjs`](../scripts/victor/fork.mjs)                                   | Implements upstream-refreshed status and fork history, shared-main guards, user-namespaced feature branches from fetched fork main, upstream-update merges, confirmed branch publication and prefixed PR creation, focused checks, and immutable release-tag publishing. Never merges PRs or rewrites main. |
| [`scripts/victor/check-pr-title.mjs`](../scripts/victor/check-pr-title.mjs)               | Validates PR title prefixes against the head branch for the [`Fork checks` workflow](../.github/workflows/fork-checks.yml). Reads event metadata only; never renames commits or upstream history.                                                                                                           |
| [`test/victor-input.js`](../test/victor-input.js)                                         | Supplies recorded microphone input and observes submissions, generated audio, playback, and teardown in an isolated `test/serve.ts` session. Keeps both speech engines real; observations are not automatic assertions or proof of audible device output.                                                   |

The built-in [`src/server/extensions/victor-reply-style.ts`](../src/server/extensions/victor-reply-style.ts)
selects the reply-style prompt section from the active run's newest input and its request-keyed
`VictorInputsDoc` metadata. It uses `PocketHost.submissionRequestId` to resolve the submission.
[`src/server/reload.ts`](../src/server/reload.ts) registers its order and Extensions-sheet title.

### Shared Pi Pocket dependencies

These are integration hooks and shared dependencies, not files owned exclusively by Victor or a list of fork edits. Before changing shared behavior, inspect its other callers and tests. General application dependencies are omitted.

| File                                                                                  | Victor dependency and shared behavior to preserve                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`web/composer.js`](../web/composer.js)                                               | Mounts controls, guards typed drafts, attachments, and pending sends, and restores unsent speech to its original conversation. Preserve ordinary send/steer/queue, commands, attachments, and draft insertion without losing either draft.                                                             |
| [`web/voice.js`](../web/voice.js)                                                     | Gives Victor exclusive audio ownership across dictation boxes, including PiP and Alt+V, until Victor is off. Preserve caret-aware dictation, typed text, cancellation of late results, and PiP shortcut priority.                                                                                      |
| [`web/store.js`](../web/store.js)                                                     | Supplies connection, conversation, attribution, and queue state, per-conversation drafts, and API calls. Preserve incremental view merging, draft isolation, and HTTP error statuses used to distinguish rejected submissions from uncertain delivery.                                                 |
| [`web/ui.js`](../web/ui.js)                                                           | Supplies UI helpers and `replyText`, which excludes thinking and tool calls and also serves ordinary reply actions. Keep speech-specific cleanup in `victor-mode.js`, not shared reply extraction or Markdown rendering.                                                                               |
| [`web/app.js`](../web/app.js)                                                         | Starts shared service-worker registration. Keep it independent of notification support and non-blocking for normal app startup, badge updates, and incoming shares.                                                                                                                                    |
| [`web/service-worker.js`](../web/service-worker.js)                                   | Shares one registration between app startup, notifications, and Victor; bounds Victor's first-install wait for page control. Preserve operation without push permission, unsupported-browser fallbacks, and timeout/listener cleanup.                                                                  |
| [`web/notify.js`](../web/notify.js)                                                   | Uses shared worker registration while keeping notification capability and permission checks separate. Victor caching must work without push support; preserve notification subscriptions, preferences, and badge behavior.                                                                             |
| [`web/sw.js`](../web/sw.js)                                                           | Dispatches versioned asset requests to the Victor cache helper. Preserve push display, approval actions, notification navigation, PiP opening, and share-target handling; app/API requests must stay outside the Victor cache and share handling must take precedence.                                 |
| [`web/index.html`](../web/index.html)                                                 | Loads `victor.css` after shared styles. Preserve the app entry point, local import map, theme-before-paint script, and mobile/home-screen metadata.                                                                                                                                                    |
| [`web/style.css`](../web/style.css)                                                   | Supplies theme variables, controls, focus states, and composer layout. Keep Victor-specific overrides in `victor.css`; shared changes also affect ordinary composers, touch targets, and iOS field sizing.                                                                                             |
| [`src/server/http.ts`](../src/server/http.ts)                                         | Routes `/victor-assets/` to the optional asset handler. Preserve API, authentication, artifact, share-fallback, and static routes; missing Victor assets must not prevent ordinary app use.                                                                                                            |
| [`src/server/http/assets.ts`](../src/server/http/assets.ts)                           | Allows WebAssembly in the app policy and applies dedicated security headers to Victor worker/worklet scripts. Preserve same-origin restrictions, inline-script hashes, and app-file revalidation (`no-cache`); do not broaden ordinary JavaScript evaluation permissions.                              |
| [`src/server/http/conversation-routes.ts`](../src/server/http/conversation-routes.ts) | Accepts Victor text through the ordinary submit endpoint, validating text/request IDs and filtering attachment paths; Commands also validates the optional Victor source enum. Preserve validation for every client; there is no separate Victor submission route.                                     |
| [`src/server/commands.ts`](../src/server/commands.ts)                                 | Applies existing access, driving-turn, model, spend, attribution, request-ID, and queue rules to submitted text. Records immutable input-source metadata before admission; preserve typed-message command expansion and attachments. Victor's plain-text restrictions belong in its client controller. |

### Focused test coverage

This is a starting point for selecting tests by affected behavior, not a requirement to run every listed suite. Changes to a shared contract also need its upstream tests. Keep failure signatures and their baseline evidence in [TEST_ISSUES.md](../TEST_ISSUES.md), not in this map.

[`victor-just-interface.test.ts`](../test/victor-just-interface.test.ts) checks listings, native usage, argument forwarding, and rejection of unsupported options before Git or GitHub run, using disposable fixtures. It requires Just on `PATH` (`mise install just`); CI installs the latest release.

| Behavior                                                                                                                    | Tests to inspect                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared-main guards, upstream merge ancestry, PR publication, release tagging, and failed-operation safety                   | [`victor-fork-workflow.test.ts`](../test/victor-fork-workflow.test.ts), using disposable local repositories and remotes.                                                                                                                            |
| PR title prefixes and invalid PR metadata                                                                                   | [`victor-fork-pr-title.test.ts`](../test/victor-fork-pr-title.test.ts).                                                                                                                                                                             |
| Controller lifecycle, draft ownership, reply attribution, cues, replay, and send-command finalization                       | [`victor-mode.test.ts`](../test/victor-mode.test.ts), [`victor-listening.test.ts`](../test/victor-listening.test.ts).                                                                                                                               |
| Reply-style selection, source validation, retries, queue/steer boundaries, tools, restart recovery, and extension switching | [`victor-reply-style.test.ts`](../test/victor-reply-style.test.ts). Shared integration coverage also includes [`app.test.ts`](../test/app.test.ts) and [`dropins.test.ts`](../test/dropins.test.ts).                                                |
| Worker initialization, recognition/synthesis protocol, pronunciation-pack validation, and runtime failures                  | [`victor-worker.test.ts`](../test/victor-worker.test.ts).                                                                                                                                                                                           |
| Source pins, deterministic preparation, unsafe archives, verification, and repair                                           | [`victor-assets.test.ts`](../test/victor-assets.test.ts).                                                                                                                                                                                           |
| Manifest/asset serving and security headers                                                                                 | [`victor-http.test.ts`](../test/victor-http.test.ts); production-routing cases in [`victor-composer-ui.test.ts`](../test/victor-composer-ui.test.ts). For shared HTTP behavior, inspect the web-edge cases in [`app.test.ts`](../test/app.test.ts). |
| Composer draft/attachment guards, navigation, and responsive controls                                                       | [`victor-composer-ui.test.ts`](../test/victor-composer-ui.test.ts); [`mobile-ui.test.ts`](../test/mobile-ui.test.ts) when changing shared layout or interaction.                                                                                    |
| Cache selection, failures, cleanup, interrupted downloads, and browser persistence                                          | [`victor-cache.test.ts`](../test/victor-cache.test.ts), [`victor-cache-ui.test.ts`](../test/victor-cache-ui.test.ts).                                                                                                                               |
| Ordinary dictation and Victor's exclusive audio ownership                                                                   | [`voice.test.ts`](../test/voice.test.ts), plus controller lifecycle cases in [`victor-mode.test.ts`](../test/victor-mode.test.ts).                                                                                                                  |
| Shared worker registration, first-install waiting, and notification capability checks                                       | [`service-worker.test.ts`](../test/service-worker.test.ts), [`notify.test.ts`](../test/notify.test.ts). These do not fully cover notification clicks or incoming-share workflows.                                                                   |

Controller and worker unit tests use stand-ins, and browser tests use synthetic speech or small asset fixtures. Worklet changes need explicit checks of sample batching, queue limits, and acknowledgment/flush ordering: controller tests simulate the worklet rather than exercising its processor. These suites do not establish model compatibility, physical-device audio quality, or long-session reliability; the recorded-input observer and target-device checks serve different purposes.
