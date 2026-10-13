# Minimal on-device Victor: implementation plan

Status: implemented on `plan/on-device-voice-mvp`. The user-recorded audio passed the full browser acceptance scenario with Kroko, selected through [drop-in model comparisons](on-device-victor-model-comparison.md) without architecture changes. See [validation notes](on-device-victor-mvp-validation.md) for results, repeatable steps and remaining limits.

## Goal and fixed scope

Make one complete loop work inside Pi Pocket:

**Tap Listen → speak → say “send it” → send the recognized text to Pi → wait for the final reply → speak that reply locally.**

The minimum supported device is **iPhone 13 Pro Max running iOS 27**, using Safari in the foreground. Do not spend this implementation on older hardware, older iOS releases, other languages, background operation, or a browser compatibility matrix. English only for this first version.

Use a **Victor button in the conversation composer** to toggle the mode. A slash command is not required: the button meets the requested interface and supplies an explicit user gesture for microphone/audio initialization. Leave `/Victor` for later rather than implementing two entry points.

### What “keyword-triggered VAD” means here

For this minimal version, interpret it as **keyword-controlled end of turn**, not acoustic voice activity detection or a wake word:

- While listening, run streaming STT continuously.
- A recognized trailing **“send it”** ends the utterance and requests submission.
- Silence alone never sends a message.
- Strip the command from the submitted text. Ignore capitalization and trailing punctuation; require whole words at the end, not a substring anywhere in the transcript.
- Reserve this phrase as a command while Victor mode is listening. Dictating it literally at the end is not supported yet.
- Do not load a separate VAD, keyword-spotting, embedding, or semantic turn-detection model.

This deliberately uses the recognizer to detect the command. A dedicated always-listening wake-word detector is a different feature and is out of scope.

## Smallest useful behavior

1. Start only in the main conversation, when Pi is idle, the person may submit, and the composer has no existing draft or attachments. Ask them to send or clear existing content first; never overwrite it.
2. Turning Victor on prepares the one STT model and enumerates local English TTS voices. Show a simple loading/error state, then **Listen**. Do not depend on user activation surviving an asynchronous model download.
3. Tapping Listen initializes/unlocks audio synchronously in that gesture, opens the microphone, and shows the live transcript in a dedicated victor-draft area. Do not mix interim recognition with ordinary typed text or attachments.
4. On “send it,” stop capture, flush the recognition stream, and submit the final text without the command. Submit once, not once per matching partial.
5. While waiting for Pi, keep the microphone stopped. Show the normal Pi Pocket transcript and activity; no extra Victor progress narration.
6. Once this exchange completes, speak **only its last completed assistant answer**, not live partials, thinking, tool output, or intermediate commentary.
7. After speaking, leave mode enabled in **Ready**. Tap Listen for another turn. No automatic microphone restart and no simultaneous listening/playback.
8. Turning Victor off at any point stops local audio/capture, discards late callbacks, and releases speech resources. It does **not** abort Pi's server-side work. Preserve an unsent Victor draft as ordinary composer text when practical.

This is intentionally **half-duplex and tap-between-turns**. It avoids echo cancellation as a feature dependency and avoids Safari microphone-reactivation assumptions. There is no speech barge-in; the Victor toggle is the local stop control. Existing Stop Pi remains separate.

Keep the existing browser dictation feature unchanged, but prevent it and this Victor mode from running simultaneously.

## Fixed technical choices

### STT: one sherpa-onnx worker

Use the audited generic browser runtime from **`sherpa_onnx_web` 1.13.8**, with its matching JavaScript wrapper. Do not mix current repository-head wrappers with this binary.

- Published runtime revision: `8b5a9990d2d787d6a7d4238b0d2e7777090bfd03`.
- [Package archive](https://pub.dev/api/archives/sherpa_onnx_web-1.13.8.tar.gz).
- Archive SHA-256: `e25a3813eb080636280b23dd4b0098252902675158b66dceda1efba061adf5d7`.
- WASM SHA-256: `e0d84744c39a28121f7738a161a21612788f4e8f07879a7224e74919e9831573`.
- Single-threaded SIMD inference inside a dedicated JavaScript worker; no SharedArrayBuffer, pthreads, COOP or COEP.
- Use the English **Kroko streaming Zipformer, 2025-08-06**, with its published quantized encoder, decoder, joiner and tokens: **71.05 MB** of selected files, **86.33 MB** including runtime/JS. [Model archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06.tar.bz2), SHA-256 `c8676e5ff9ac2a85296e53ee0fd4d5fb1db6770e7a7647166eeafe349ade6834`. This replaces the initially planned 20M model, which missed the opening words in the user’s recording. The runtime, wrapper and streaming API are unchanged. Kroko updates in roughly 1.28-second internal chunks; capture still sends 100 ms batches.
- Runtime WASM is about **15.1 MB**. Download only the necessary model/runtime files, not every variant or sample in the archives. Record model-file hashes in the asset manifest during preparation.
- Use the published runtime unchanged initially. Its **512 MiB initial linear memory** is a known limitation, not a measured iPhone resident-memory requirement. Do not add custom WASM builds or memory tuning to this minimal implementation.

Use one static same-origin AudioWorklet to collect mono PCM and send modest batches to the worker. Pass the **actual AudioContext sample rate** to sherpa's `acceptWaveform`; its native feature extractor already contains a stateful resampler. Do not write another chunk-local JavaScript resampler. A new sample rate requires a new recognition stream. [Native resampling implementation](https://github.com/k2-fsa/sherpa-onnx/blob/9db1af1871ed78cee9357c23898e5a7d8702d21a/sherpa-onnx/csrc/features.cc#L85-L130).

Keep one recognizer for the active mode and one disposable stream per utterance. Disable silence-driven endpoint submission. Bound queued PCM; report overload rather than accumulating an indefinitely delayed transcript. Stop an excessively long capture with its text retained, never silently auto-submit it.

### TTS: local operating-system speech

Use `speechSynthesis` and an actually enumerated English voice with **`localService === true`**. No neural TTS download, voice picker, cloning, second inference runtime, or external speech API.

- Enumerate immediately and on `voiceschanged`; fail visibly if no local English voice becomes available. Never silently select a remote/default voice.
- Prime speech synchronously in the Listen tap, before awaits. The eventual reply must produce real `onstart`/`onend` or `onerror` events; an empty priming utterance is not proof of successful playback.
- Reuse `replyText(entry)` for assistant text blocks. Convert the completed answer's Markdown to plain text using the existing parser/DOM facilities: omit code blocks and images, keep ordinary prose and link labels, and remove markup. Do not build a streaming Markdown parser.
- Speak one completed answer as one utterance. No sentence streaming, background queue, or special voice prompt.
- On cancellation, invalidate a local generation token before calling `speechSynthesis.cancel()`. Ignore stale start/end/error callbacks. Handle errors and a stalled start with a visible retry state.

The built-in browser on this host exposes local voices after asynchronous enumeration. Its initial empty `getVoices()` result must not be treated as a permanent failure.

### Assets and security: only what this loop needs

Add a small preparation script and an explicit asset manifest. Download the pinned runtime and selected model files into a gitignored local directory such as `vendor/victor/`; do not commit model binaries or write directly into Pi Pocket's live data directory.

Serve that allowlisted directory through a same-origin victor-assets route with correct content types, streamed file reads, and versioned immutable HTTP caching. Use ordinary HTTP caching for this version—no Cache Storage manager, service-worker changes, storage-persistence UI, offline app shell, or model-selection UI. Report loading failures and allow retry.

Serve the worker/worklet as static same-origin scripts. Permit WASM compilation with `'wasm-unsafe-eval'` where required, including the worker's effective policy. Keep JavaScript `unsafe-eval`, Blob script loading, external connections, and global cross-origin isolation out of the implementation. Leave artifact/Run-frame policies unchanged.

## Conversation integration without a new streaming protocol

Use existing `/api/c/:id/submit` and existing committed conversation views. **Do not add narration events, generation IDs to the server, a Victor document kind, or a prompt extension.** Waiting for the completed exchange avoids those requirements in this reduced scope.

At submission:

- Capture the conversation ID, the current entry boundary, the recognized text, and one stable request ID for this attempt.
- Send through the authenticated API helper with that explicit conversation ID and request ID. Reuse the ID for any retry; do not call a delayed helper that reads whichever conversation is now selected.
- Require idle state and submission permission immediately before sending. Use normal `followUp` semantics; do not add automatic steering or abortion.
- Send text directly, not through composer shell/slash-command parsing.
- Latch the accepted submission and reconcile against the current view even if the reply arrived before the POST response. Do not require observing a transient `busy=true` update to notice a fast reply.

For narration, wait for the accepted exchange to be idle and choose its newest successful assistant answer after the saved boundary. Mark its entry ID consumed before starting TTS. Never narrate existing history on enable or replay a full reconnect snapshot.

This first version supports **one active Victor exchange in one tab**, not concurrent multiplayer Victor. If another user message makes response ownership ambiguous, a reconnect occurs, the conversation changes, or permissions change, stop Victor and require another explicit activation. Do not guess which reply to read or alter other participants' work. This conservative fallback avoids adding a full server-side attribution protocol.

Use a small local state machine:

`off → preparing → ready → listening → submitting → waiting → speaking → ready`

Any state can go to off/error. Navigation, hidden-page transition, pending microphone acquisition, worker messages and TTS callbacks all check the same local activation token so old operations cannot restart audio or submit late text.

For command handling, a matching partial is a **candidate**, not an immediate POST: freeze capture, finish/drain the recognizer, and re-check the suffix in the final text. If final recognition no longer contains the command, keep the draft and return to Ready without sending. Empty text after removing the command also sends nothing.

## Implementation sequence and likely files

1. **Deliver one pinned ASR bundle.** Add `scripts/victor/prepare-victor-assets.mjs`, a checked-in manifest, `.gitignore` entries, and the small static route/MIME/CSP changes in `src/server/http.ts` and `src/server/http/assets.ts`. No dependency framework or app build pipeline.
2. **Add capture and recognition.** Add `web/victor-capture-worklet.js` and `web/victor-worker.js`. Own stream creation/freeing and transfer PCM at its actual sample rate. Implement partial/final transcript messages and explicit finalization.
3. **Add the mode and keyword submission.** Add `web/victor-mode.js`; wire a Victor toggle, Listen control, status and Victor draft into `web/composer.js` and minimal CSS. Reuse the store/API helpers. Add an explicit-ID/request-ID submission helper only if necessary; preserve existing typed-message behavior.
4. **Read the completed reply aloud.** In the same mode controller, observe committed views, choose the new final answer conservatively, extract plain text, and invoke native local TTS. Implement local cancellation and teardown; no separate narration subsystem.
5. **Run the one end-to-end browser acceptance test below.** Add only the short audio fixture/test-server plumbing needed to feed real audio. Update `docs/features.md` with the exact toggle, reserved phrase and half-duplex behavior once implemented; keep the project map accurate for the new modules.

Stop there. In particular, **do not** implement a slash command, separate VAD/KWS, automatic turn-taking, barge-in, live reply narration, neural TTS, server Victor preferences, multi-tab election, benchmark suite, custom ORT build, or asset-management settings.

## Only feature acceptance test: local Pi Pocket in the built-in browser

Use a throwaway instance, never the running conversation's live data. On this Mac, start:

```sh
node test/serve.ts 8899 127.0.0.1
```

Run it in the background when driving it from the agent. Use the owner sign-in link it prints. Keep the real server on `localhost` to avoid cookie collisions. The existing scripted backend replies `echo: …`, which exercises Pi Pocket's real submission, durable conversation, event transport and UI without needing an external LLM. **Do not mock STT or TTS.**

### Feed audio, not a fake transcript

The built-in browser is headless Chromium on the server, not the iPhone microphone. Use the user-provided recording saying **“Hello there. Please say the word sunshine. Send it.”**, decoded to a separate WAV without trimming or changing its sample rate. Serve it only from the throwaway test server. In that browser page, replace the microphone source for the test with a Web Audio `MediaStreamDestination` fed by the recording; the recording still traverses the production AudioWorklet, worker and actual ASR model. A test-only microphone-source override is sufficient—do not add production debug routes or transcript injection.

### One acceptance scenario

1. Open the local copy through the built-in browser at a phone-sized viewport and enable Victor. Wait for actual model initialization and an enumerated local English voice.
2. Click Listen and feed the recording. Observe partial text and keyword-triggered finalization.
3. Confirm **exactly one** new user message was submitted, containing the recognized greeting but not “send it.”
4. Confirm the normal transcript receives the scripted Pi reply and reaches idle.
5. Confirm native TTS uses a local voice with the reply's plain text and fires actual start/end events, returning the mode to Ready. Instrument events if necessary without replacing `speechSynthesis` with a stub.
6. Turn Victor off, confirm capture/worker teardown and no extra submission or replay. Inspect the browser console and the speech asset/API request trace for errors or third-party speech requests.

Record the result and any blocker. If real recognition or native TTS fails, the scenario is not a pass; do not substitute a canned transcript or mocked speech engine.

**What this proves:** the end-to-end Pi Pocket integration works in the built-in Chromium with real local speech engines. The browser launches with `--mute-audio`, so speech events are not proof of audible speaker output. Neither a mobile viewport nor this test validates iOS 27 routing, permissions, latency, memory survival or audio unlock. Those remain unverified; no additional physical-device test gate is requested for this minimal plan.

No new unit-test suite, separate integration suite, benchmark, soak test, or device matrix is part of feature acceptance. Repository-mandated editing/check commands in `AGENTS.md` still apply when code is implemented; this plan does not override them.

## Done for this iteration

The feature exists when the UI toggle enables the real local STT → keyword submit → Pi Pocket final reply → local TTS loop, the single browser scenario passes, and switching it off releases local speech resources without stopping Pi. The implementation is then ready for the user to try on the stated iPhone, without claiming that the desktop browser has certified that device.
