# Kitten Micro TTS: minimal implementation plan

Status: implemented; desktop browser validation passed. Physical iPhone audio/performance qualification remains pending. See the [validation results](on-device-victor-kitten-validation.md).

## Goal and scope

Replace Victor mode's local system speech with **Kitten Micro v0.8**, running on the user's device through the existing sherpa-onnx WASM runtime. Fix the speaker to **ID 2, `expr-voice-3-m`**. Default to **1.25× speaking speed**, with a small per-browser speed control.

Keep Kroko STT, “send it,” completed-answer selection, automatic listening, Read reply, draft preservation and permission/navigation checks unchanged. This changes the current automatic conversation loop described in [the validation notes](on-device-victor-mvp-validation.md), not the original plan's older tap-between-turns behavior.

No voice/model picker, cloud or system-speech fallback, new runtime, server speech API, durable preferences, or background speech. Keep one complete reply per synthesis request for this first change; sentence-by-sentence generation and audio prefetching are deferred. Consequently, playback waits for the whole reply to be synthesized, even when generation is faster than playback.

## 1. Add pinned TTS assets

Files: `victor-assets.json`, `scripts/victor/prepare-victor-assets.mjs`.

- Keep the current sherpa runtime, ASR wrapper and Kroko files unchanged. Add the matching `assets/sherpa-onnx-tts.js` from the already-pinned `sherpa_onnx_web` 1.13.8 archive. Its SHA-256 is `b9cb4782010b22d64be31298a3e407170d2b8f5def471ea6011c42a921577e8f`.
- Add the [Kitten Micro v0.8 archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kitten-micro-en-v0_8.tar.bz2), SHA-256 `85faaea7511ca9d1d2f251fed0a4553bdf0d1ee046102fa60ddd8046c751f76f`.
- Pin sizes and hashes for `model.onnx`, `voices.bin`, `tokens.txt` and the `espeak-ng-data` pronunciation files. Give TTS assets distinct public names and a separate worker filesystem directory so they cannot overwrite ASR tokens or models. Preserve the pronunciation directory layout.
- Keep the supplied voice bank and pronunciation data intact. Fixing speaker 2 does not require repacking the model or removing other voices. Language/voice-bank pruning is outside this change.
- Extend preparation for the additional archive and remove hard-coded “two archives/seven files” messages. Retain verified extraction, hash-named files under ignored `vendor/victor/`, and the existing HTTP allowlist.
- Bump the bundle URL because responses are immutable. TTS adds approximately **62.7 MB** of assets; the combined Victor bundle is approximately **149 MB**. A new bundle URL also means existing ASR browser cache entries cannot be assumed reusable.

No new route or CSP relaxation is needed. The server reads the manifest at startup, so rollout requires an owner-requested restart after asset preparation and validation.

## 2. Extend the existing speech worker

File: `web/victor-worker.js`.

Keep one worker and **one shared WASM instance** for ASR and TTS. Create both engines once per Victor activation and report ready only when both are usable. Retain the recognizer and any unfinished recognition stream during replay.

**Initialization order matters:** create the ASR recognizer completely before importing the TTS wrapper. Both wrappers define a global `freeConfig`; loading TTS first would replace ASR's cleanup helper before its constructor uses it. Import each wrapper once. Retry failed initialization with a fresh worker, not by reconstructing ASR after the TTS import.

Mount TTS files, then create `createOfflineTts(runtime, config)` with the Kitten model/voices/tokens/data directory, CPU provider, one thread and `maxNumSentences: 1`. Fix Kitten `lengthScale: 1.0`; only generation `speed` changes the speaking rate. Require a valid TTS handle, speaker 2 to exist, and the expected 24 kHz output metadata. Keep pronunciation data available for later generations; do not blindly copy ASR's immediate filesystem cleanup.

Add one request/result pair for synthesis, carrying a distinct speech request ID. The worker fixes the speaker internally:

```js
const audio = tts.generateWithConfig(text, {
    sid: 2,
    speed, // Validated preference; default 1.25.
    silenceScale: 1.0,
});
```

Reject empty, non-finite or all-zero output. Return a standalone transferable `Float32Array` and the generated sample rate, not a view into WASM memory. Use a separate synthesis-error response so an ordinary TTS failure is not confused with an ASR failure.

## 3. Replace native speech playback

File: `web/victor-mode.js`.

- Remove system-voice enumeration, `voiceschanged`, empty-utterance priming and the `speechSynthesis` capability requirement. Keep synchronous creation/resumption of the existing `AudioContext` on the Victor tap.
- Preserve `speechText()`, reply attribution and `finishReply()`. Stop capture before requesting synthesis. Reuse the existing speaking phase, showing “Preparing speech…” until audio is ready.
- Play returned PCM through an `AudioBufferSourceNode` on the existing context. Construct the buffer at the **generated audio's sample rate**, not the microphone rate. Leave `playbackRate` at **1**: the model's `speed` parameter implements the user's rate without pitch shifting.
- Check both the activation token and speech request ID before accepting results or handling playback completion. Clear the active speech request before stopping audio, so duplicate or stale callbacks cannot play speech or restart capture.
- On completion, resume listening through `finishReply()`. Read reply must still preserve an unfinished dictated draft and synthesize again using the current speed.
- Separate synthesis and playback watchdogs. Give synthesis a length-aware deadline capped at three minutes, not the old ten-second native-speech startup timer; base the playback watchdog on buffer duration plus a margin. A stuck synchronous WASM generation cannot handle a cancellation message: on generation timeout, WASM abort or worker failure, terminate the worker and show the existing stopped/error state rather than trying to resume STT on a blocked or broken worker. Recoverable synthesis/playback errors may resume listening only when the worker and context remain usable.
- On Victor off, navigation, hiding or lost ownership, invalidate requests, stop/disconnect playback, clear PCM references and terminate the shared worker. Never abort Pi. Handle context suspension during playback as well as capture; do not assume the old system-speech Silent-mode behavior applies to Web Audio.

## 4. Add one speed preference

Files: `web/victor-mode.js`, `web/composer.js`, minimal `web/style.css` changes if needed.

Add a labelled **Speed** select beside the existing Victor controls: **0.75×, 1×, 1.25×, 1.5×**. No speaker selector or additional settings sheet.

Default to **1.25×**. Save only the rate in browser local storage under `pocket.victor.speed`; invalid/missing values fall back to 1.25. Storage failures must not prevent Victor use. Validate the rate again in the worker.

Snapshot the speed when synthesis starts. Changes apply to the **next reply or Read reply**, not audio already being generated or played. Keep the controls touch-friendly and within a 390 px viewport.

## 5. Validate the fixed voice and existing loop

Use the throwaway app from [self-editing](../self-editing.md#check-it-on-a-copy), never live data. Update `test/victor-input.js` to observe generated PCM and Web Audio completion instead of native speech events; keep real STT and TTS in the acceptance run.

- Verify the pinned model's speaker mapping and actual requests use **`sid: 2`**, not the previously tested speaker 0. Confirm default 1.25×, all offered rates, preference persistence and invalid-value fallback.
- Run two recorded-input turns, each submitting once and returning to listening after playback. Check nonempty, finite, non-silent PCM, the correct output rate, same-origin asset requests and no system/cloud speech calls.
- Replay during an unfinished draft; confirm the draft survives. Exercise Victor off during synthesis and playback, late/duplicate results, a synthesis error, a generation timeout and a suspended context. No late speech, microphone restart or duplicate submission may follow teardown.
- Check both engines remain usable in the **same WASM instance** across turns. Earlier standalone TTS checks did not establish combined ASR/TTS memory behavior.
- On the target iPhone Safari, audibly check speaker 2, playback activation/routing and repeated turns. At 1.25×, measure generation time against generated audio duration on representative replies: aim for **no slower than playback**, excluding initial asset loading. Record first-audio delay and memory survival separately. The earlier approximately 0.65 ratio was a short desktop test of **speaker 0**, not qualification of speaker 2 or the phone. If the phone check is unavailable or fails, report that limit rather than declaring the performance requirement met.

Run `node --check` on changed web files, then `npm run format`, `npm run lint`, `npm run check` and `npm test`. Add focused regression checks for rate validation and stale speech completion using existing test patterns. Update `docs/features.md`, `docs/map.md` and `docs/architecture.md` when implementation lands.

## Done

Victor mode narrates through local Kitten Micro v0.8, always speaker 2, with 1.25× as the customizable default. Existing conversation behavior is preserved, the real browser loop passes, and phone performance is recorded honestly. Asset preparation is complete. Rollout still requires the owner to restart the server; implementation did not restart, commit or deploy it.
