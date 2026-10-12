# On-device Victor: smaller integration points

Status: steps 1–5 implemented. The optional conversation adapter in step 6 is deferred; audio and reply-ownership logic remain together. See [On-device Victor](../victor.md) for the current operating guide.

## Goal and scope

Reduce the feature branch's exposure to upstream changes by moving Victor implementation out of shared files and testing the boundaries that remain. Keep the current browser-local recognition and Kitten speech behavior. Prefer ordinary modules, explicit imports, and small component interfaces over a plugin framework.

The server-side spoken-reply conversion proposal is cancelled. Do not introduce conversion requests, extra model calls, internal child conversations, speech tasks, billing changes, or new durable documents. Victor continues to speak the existing completed answer locally.

The review used merge base `1e8715b` on `feature/on-device-voice-kitten-tts`. Most Victor code already lives in new files. The important shared integration points are `web/composer.js`, `web/voice.js`, `web/notify.js`, `web/sw.js`, `web/style.css`, and `src/server/http/assets.ts`.

## Rules for the refactor

- Separate mechanical moves from intentional behavior changes. The only planned failure-handling change is making an unavailable Victor manifest fail Victor requests rather than server startup.
- Keep one Victor controller and its existing epoch, turn, capture, and speech identifiers. Do not split the audio lifecycle into independent services or replace its state machine.
- Preserve synchronous AudioContext creation/resume on the initiating tap, before any await. Do not put a dynamic import or service-worker wait ahead of it.
- Preserve import initialization and store subscription order. Do not introduce import cycles among the composer, controls, controller, store, and notification modules.
- Keep the same submission payload, conservative ownership checks, draft preservation, and uncertain-delivery behavior. Local stop must never abort the shared agent run.
- Keep asset URLs, manifest pins, worker messages, cache names, speed preferences, CSP restrictions, and artifact isolation unchanged.
- Do not register a second service worker, introduce a build step, or add a general frontend extension registry.
- Leave Pocket's server extension API alone: it is not a browser-component or HTTP-route plugin API.

## 1. Add regression coverage at the existing boundaries

Do this before moving code, so the tests establish the behavior being preserved.

### Dictation and composer

Extend `test/voice.test.ts` to exercise the real `setDictationBlocked` implementation rather than the controller tests' stand-in:

- Blocking stops the current recognizer and discards late recognition results.
- Alt+V and PiP's dictation box cannot bypass the block.
- A box mounted while blocked starts blocked.
- Turning Victor off restores dictation; repeated block/unblock calls are harmless.

Add a focused composer browser test, following the existing isolated-app UI tests. Stub speech resources, not the composer/controller integration. Cover:

- Typed text, attachments, and a pending typed submission prevent activation.
- Turning Victor on prevents typed submission, paste, and attachments without corrupting the draft.
- Navigation or unmount preserves unfinished speech in the captured conversation, never the newly opened one.
- Inserted text/files turn Victor off before insertion and preserve both pieces of content.
- Permission, model, queue, and connection changes retain their existing safety behavior.

Keep real-engine qualification separate: these tests do not establish microphone accuracy, iPhone routing, or audible quality.

**Done:** the new tests pass against the pre-extraction implementation, or any existing failure is documented and handled separately rather than silently fixed during a move.

## 2. Extract Victor controls and centralize eligibility

New file: `web/victor-controls.js`.

Move `useVictorMode`, `VICTOR_STATUS`, and the controls panel out of `web/composer.js`. Export the hook and small rendering components needed for the panel and idle Victor button. Keep the controller independent of these components.

Composer retains the integration that genuinely belongs to it:

- Its text, files, sending state, and draft restoration callback.
- Its captured conversation/unmount cleanup.
- Guards around typing, paste, attachments, shortcuts, and submission.
- Explicit component mounts and the controller activation call.

Do not move arbitrary composer state into the Victor controller just to reduce line count. A small amount of visible glue is preferable to an opaque hook with many callbacks.

Expose the controller's existing availability check through one documented function or method. Both activation UI and controller checks use it for session type, permissions, model selection, connection, busy state, and queued messages. Composer adds only its local checks for text, attachments, and an in-flight typed submission. Preserve all checks currently enforced; standardizing duplicate notices is acceptable, weakening eligibility is not.

Keep controller rechecks immediately before capture and submission. An earlier UI check is not sufficient after an asynchronous wait.

**Done:** status labels and panel markup no longer live in Composer; shared eligibility rules have one implementation; draft and audio ownership tests still pass. Activation still creates/resumes audio on the original tap.

## 3. Extract Victor HTTP assets

New file: `src/server/http/victor-assets.ts`.

Move the manifest loader, allowlist, Victor asset handler, and worker-specific policy definitions out of `http/assets.ts`. Import the handler directly from `http.ts`, retaining the existing `/victor-assets` dispatch.

Keep a small explicit policy helper for the two speech scripts where general file serving needs it. The Victor module must not import `http/assets.ts`: pass the file/path information it needs or derive it from `APP_ROOT`, avoiding a cycle. Keep the app's WASM CSP allowance explicit in the general policy; do not introduce a generic policy-provider registry.

First move the current implementation unchanged. Then make manifest initialization lazy:

- Importing the HTTP handler and serving ordinary app files must not require a readable Victor manifest.
- Load and validate the manifest when serving Victor assets. Cache successful initialization for the process, not a rejected promise or permanent failure.
- Validate bundle/path layout and asset fields before constructing the allowlist. Request paths must never become filesystem paths.
- Missing or malformed manifest data returns a controlled Victor-specific 503 without leaking filesystem details. A later request can retry after repair.
- Preserve 404 for unknown assets in a valid manifest, 405 for unsupported methods, GET/HEAD behavior, ETags, immutable caching, CORP/CSP, streaming, and disconnect cleanup.
- Replacing a successfully loaded bundle remains a server-restart operation; this is not a new manifest hot-reload feature.

Extend HTTP tests using temporary fixture roots or an explicit loader seam, never by renaming the live repository's manifest. Test missing/malformed manifests, repair and retry, ordinary app availability, allowlist rejection, headers, and stream behavior. Retain asset preparation/hash tests.

**Done:** general asset serving contains no manifest parsing or model streaming logic, and broken optional Victor assets do not prevent ordinary app startup.

## 4. Separate service-worker infrastructure from Victor caching

New files: `web/service-worker.js` and `web/victor-cache.js`.

### Registration

Move `registerWorker` and `waitForWorkerControl` from `notify.js` into `service-worker.js`. Update `app.js`, `notify.js`, and `victor-mode.js` to import from their owning module; avoid a compatibility re-export through notifications.

Keep registration at app startup, independent of push support or notification permission. Preserve the bounded control wait, null/no-wait behavior, registration failure fallback, and the single shared registration promise. Notification UI continues to check PushManager and Notification support separately.

Move infrastructure tests to a focused service-worker test file; retain notification-specific coverage in `notify.test.ts`.

### Cache helper

Keep `/sw.js` as a classic worker. Load `victor-cache.js` with a same-origin `importScripts` call. The helper should expose one narrowly named handler, for example `self.pocketVictorCache.handleFetch(event)`, returning whether it handled the event. Keep its internal cache state private in a closure.

The helper owns Victor request matching and caching. `sw.js` keeps one fetch listener: dispatch shares first, then delegate Victor requests. The helper must call `respondWith` synchronously for a matching event; asynchronous cache/network work runs inside that response promise. Do not add a competing fetch listener or swallow helper syntax/load errors with an offline fallback.

Preserve cache hits, partial downloads, bundle cleanup, cache failure fallback, response cloning and `waitUntil`, and exclusion of API/app/manifest/range/cross-origin requests. Do not prefetch or cache the application shell.

Update the VM harness to execute the actual imported helper rather than duplicating its source. Keep the real-browser cache test and add/check coverage for a service-worker update with the imported helper. Verify script serving, CSP, and update behavior in Chromium.

**Done:** notifications and shares retain their behavior; Victor cache changes normally touch only the helper and its tests; `victor-mode.js` no longer imports notification UI code for registration support.

## 5. Extract styles and consolidate documentation

New files: `web/victor.css` and `docs/victor.md`.

Move Victor-specific selectors from `style.css`, including narrow-screen overrides, into the new stylesheet. Add one link after `style.css` in `web/index.html`. Restore shared selectors such as the Plan chip rule to their original scope; express the corresponding Victor chip styling in the new file.

Moving rules to the end of the cascade can change equal-specificity behavior. Preserve the current responsive breakpoints and check computed layout, not just textual equivalence. Test Victor off/on/error states at 390 × 844, the narrowest supported phone layout, and desktop. Check model labels, Plan visibility, disabled inputs, focus, and touch targets.

Consolidate detailed architecture, asset preparation/cache behavior, limitations, and test guidance in `docs/victor.md`. Leave short summaries and links in `docs/architecture.md`, `docs/features.md`, and `docs/map.md`; keep historical validation plans as evidence rather than treating them as the current operating guide. Update those links and module descriptions in the same implementation step that moves their subjects.

Avoid unrelated table alignment changes in `docs/map.md`. Review the diff after formatting and remove unrelated churn without reverting anyone else's work.

**Done:** future Victor styling and operational documentation edits generally stay in Victor-owned files; the app and docs load their new dependencies correctly.

## 6. Optional follow-up: isolate Pocket conversation assumptions

This is not required to finish the first five steps. Only undertake it if the resulting boundary is smaller and clearer than the existing code.

A `web/victor-conversation.js` module could own Pocket-specific eligibility, submission, and exchange classification. Keep it a concrete adapter, not an injectable provider framework. It must not import the controller or own audio, timers, or draft UI.

Extract the current store/entry interpretation mechanically. Keep conservative decisions about attribution, changed history, competing messages, and final answers. Preserve the submission receipt, including the existing `submissionId`, when moving submission handling; do not claim that retaining the ID alone establishes exact reply ownership. Do not add an API or change matching semantics in this refactor.

Test classification against representative projected entries, including reset, missing attribution, failed answers, and additional user-kind entries. Consolidate duplicated controller test fixtures only when needed to support this seam; do not turn test cleanup into a prerequisite for the smaller extractions.

The existing local Markdown-to-speech conversion remains. If extracting it into a helper, test with the real parser and sanitizer, not only the controller's plain-text stand-ins. No conversion model or server narration path replaces it.

## Existing issues kept separate

The cancelled spoken-replies plan also recorded issues unrelated to that proposal. Preserve them as follow-up work, not as acceptance criteria silently added to this refactor:

- Subagent reports represented as user-kind entries can trigger the controller's competing-message guard. Fixing this requires trustworthy provenance, not allowing every extra user entry.
- An unresolved original submit response can leave Victor in Sending before its reply watchdog starts. Any eventual timeout fix must preserve uncertain-delivery handling and must not resend under a new request ID.
- Listening/Speak now can appear before microphone acquisition and the start cue finish. A future fix should distinguish capture preparation from connected capture while keeping capture-ID checks.
- Physical iPhone routing, audible latency, and repeated-turn memory survival still need device qualification; moving modules does not establish these properties.

These are carried forward from the previous review, not newly reproduced by writing this plan.

## Validation and delivery

Implement in the numbered order, treating each extraction as an independently reviewable diff. Do not commit or push without approval.

For implementation, follow [self-editing.md](../self-editing.md): use an isolated app with temporary data; do not exercise the live session or restart the running server. Keep every intermediate web save loadable, adding dependencies before updating consumers.

1. Run `node --check` immediately after each JavaScript edit.
2. Run targeted dictation, controller, worker, asset, cache, notification, and new integration tests after the relevant step.
3. Check the isolated app in Chromium at phone and desktop sizes, including console errors, normal typed chat, Victor activation/teardown, shares, and notification capability without push.
4. Run `npm run format`, `npm run lint`, `npm run check`, and `npm test`. Compare failures with the recorded baseline in `TEST_ISSUES.md`; report exact failures rather than assuming they are pre-existing.
5. Inspect the final diff against the feature branch's upstream merge base. Shared files should contain short imports, mounts, guards, route delegation, or policy integration—not new Victor implementation blocks.
6. Document remaining upstream dependencies and manual/device checks not performed. After validated server changes, ask the owner to restart; do not restart automatically.

Success means smaller, explicit integration points and unchanged user-visible Victor behavior, except for the deliberately improved manifest-failure isolation. It does not mean zero shared-file edits or a universally pluggable frontend.

## Implementation validation

Steps 1–5 are implemented; step 6 remains optional and was not undertaken. No commits, deployment, or live-server restart were performed.

- Before extraction, all 16 dictation/composer boundary tests and 107 controller/worker tests passed. After extraction and layout coverage, all 17 dictation/composer tests passed.
- Full formatting, format verification, ESLint, TypeScript, JavaScript syntax, and diff checks passed.
- The full suite completed with **677 passed, 7 failed, none skipped**. All Victor tests passed. Six failures match baseline-confirmed issues; the seventh matches the documented branch-only compaction timing failure and passed an isolated rerun. See [known test issues](../../TEST_ISSUES.md); that rerun does not prove the timing issue exists on the release.
- Chromium checked 320px, 390px, and 1280px layouts, including off/on/error states, readonly input, draft restoration, Plan/thinking visibility, and focus. The existing mobile Read reply button remains 38px high because of the shared `.button.small` override; toggle and speed controls remain at least 40px. This refactor does not change that baseline.
- Browser cache tests exercised the actual imported classic-worker helper, including helper-only updates and retained cached bytes. An isolated app also served the production manifest (366 assets), the helper, and stylesheet successfully; a share POST still redirected and stored its metadata. Typed chat worked after local Victor teardown, and the final test copy's console was clean.
- Browser layout/controller tests used stand-in speech resources. Physical iPhone audio, real-engine accuracy/latency, and long-session memory qualification were not rerun.

Relative to the upstream merge base, `web/style.css` has no remaining Victor changes; `http/assets.ts` has only policy integration and the existing WASM allowance; `sw.js` imports and dispatches the cache helper. Composer retains its explicit draft/input glue. Shortening the map's worker filename cell also removed the branch's unrelated table-alignment churn.
