# Kitten Micro Victor validation

This replaces the system-speech portion of the [earlier MVP validation](on-device-victor-mvp-validation.md). The scope and fixed voice are in the [implementation plan](on-device-victor-kitten-tts.md).

## Recorded results (2026-10-11)

Prepared and reverified all **366 assets (149,022,586 bytes)**. TTS adds 62,688,611 bytes, including all 355 pronunciation files. The original seven recognition/runtime files are unchanged. Metadata in the pinned ONNX model identifies eight speakers, **ID 2 = `expr-voice-3-m`**, and 24 kHz output. Worker regression checks verify the actual generation configuration fixes `sid: 2` and uses a single runtime with ASR construction before TTS import.

In the throwaway app, desktop Chromium at 390 × 844 passed:

- Two consecutive turns from one Victor tap, using the earlier human recording (`human.wav`, SHA-256 `48fd354e23852d67f840014f19c7fce011255807680cc776332caf3e1e4b5890`). Each submitted once with a distinct request ID, retained all non-command words, committed its exchange, generated real Kitten PCM, and returned to listening. Punctuation varied as before.
- Both turns and three completed replays used one worker and one AudioContext. This exercises both real engines together across turns, not only standalone TTS. The capture context ran at 44.1 kHz; every speech buffer was nonempty, finite, non-silent 24 kHz PCM, played with playbackRate 1. Capture tracks ended before synthesis and playback.
- All four offered speeds generated and completed. The saved 1.5× preference survived reload; an invalid saved value fell back to 1.25×. No system-speech calls or app/CSP console errors appeared. Page-observed requests were same-origin; worker URL validation and CSP restrict its assets to the same origin.
- Victor off during real synthesis terminated the worker with no returned PCM or late playback. Victor off during real playback stopped/disconnected audio, closed the context, ended capture tracks, and caused no extra submission or microphone restart.
- A separate run shortened the second fixture playback to its first three seconds, leaving a real unfinished ASR draft. Read reply retained the same recognition stream and draft (`Hello there. Please saying`), returned to listening, and Victor off restored that text to the composer. This is a draft-preservation check, not an accuracy claim for the truncated phrase.
- Suspending the real AudioContext during playback produced the stopped/error state, terminated the worker, closed the context, and ended all tracks without reopening capture or submitting again.
- The Speed select and Victor controls fit within 390 px with no horizontal overflow.

Short-reply desktop timings at default 1.25×, excluding initial loading:

| Reply       | Generation to PCM | Audio duration | Generation / audio | Request to playback start call |
| ----------- | ----------------- | -------------- | ------------------ | ------------------------------ |
| First turn  | 2.824 s           | 4.450 s        | 0.634              | 2.831 s                        |
| Second turn | 3.417 s           | 5.025 s        | 0.680              | 3.424 s                        |

Initial preparation took about 6.6 seconds in this local-server run. Other replay durations were 8.10 s at 0.75×, 6.10 s at 1×, and 4.05 s at 1.5×. These short replies are not representative phone benchmarks. Repeated-turn survival was observed; peak WASM/device memory was not measured. The browser is muted by its launcher, so completion and start-call timings do not prove audible output or acoustic first-audio delay.

Detailed browser reports are scratch files under `/tmp/pi-pocket-kitten-validation/`; the outcomes above are retained here. Regression tests cover stored-rate validation, stale/duplicate PCM and ended callbacks, teardown during each phase, recoverable synthesis/playback failures, fatal generation deadlines/WASM failures, suspended contexts, permissions/navigation, and stale microphone/worklet callbacks.

## Short-reply cutoff (2026-10-12)

A phone test reproduced a clipped ending for `Okay`, but not `Okay.`. Direct synthesis through the production worker reproduced the difference without any beep or microphone handoff: at 1.25×, unpunctuated `Okay` lasted 0.975 seconds and its last 100 ms remained active (RMS 0.067–0.070 across repeated runs). `Okay.` lasted 1.275 seconds and ended near silence (RMS about 0.000038). Neither exceeded ±1, so this was an abrupt ending, not amplitude clipping.

The worker now completes missing terminal punctuation only in synthesis input. The displayed reply is unchanged. With the real patched engine, `Okay`, `okay`, and `Okay.` all lasted 1.275 seconds and ended near silence at 1.25×; `Okay` also ended quietly at 1×. The longer comparison sentence remained quiet at its end. A worker regression test covers missing punctuation, existing sentence endings, and closing quotes or parentheses. This verifies generated PCM; the patched phone playback still needs a manual recheck.

Syntax, formatting, type checks, lint and all 104 focused Victor tests passed. The full suite finished with 587 passes and eight failures, all also present in the preceding beep-change run: branch, PiP and repository-watch path spelling; goal, plan and schedule activity ordering; Alt+A focus; and Pi-session model fallback. No Victor tests failed.

## Repository checks

- `node --check` on the changed browser/helper files, `npm run format`, `npm run lint`, and `npm run check` passed.
- Focused controller, worker, asset-preparation and existing dictation tests: **86 passed, 0 failed**.
- Full `npm test`: **519 passed, 11 failed**. The suite is **not green**.
- Nine failures match historical baseline assertions (checked against the earlier baseline logs): branch/worktree path spelling, goal activity ordering, phone Files-bar visibility, Alt+A focus, Pi-session model fallback, PiP checkout paths, plan-mode activity ordering, repository checkout paths, and schedule activity ordering.
- The many-compactions timing test failed in the full run but passed three focused reruns; earlier validation also recorded it as intermittent.
- The subagent held-back courier test (`test/subagents.test.ts`, “a batch an earlier courier sent…”) timed out waiting for `held back` in the full run and passed three focused reruns. This failure is **not proven baseline**.

Full logs and reruns are under `/tmp/pi-pocket-kitten-validation/`. No live-server restart or commit was performed. The prepared manifest is read at server startup, so the owner must use **Menu → Restart server** before testing this version in a normal browser or on the phone.

## Repeat the browser check

1. Run `node scripts/victor/prepare-victor-assets.mjs` to verify and install the pinned assets.
2. Start the [throwaway app](../self-editing.md#check-it-on-a-copy) with `POCKET_VICTOR_FIXTURE=/absolute/path/to/verified.wav`. Do not use live data. On macOS, use an unused port on `127.0.0.1`, with the real app opened as `localhost`.
3. Open its owner sign-in link, select the seeded session, and use a 390 × 844 viewport. Install the observer before tapping **Victor**:

    ```js
    window.victorE2E = await (
        await import("/__test/victor-input.js")
    ).installVictorInput({ turns: 2 });
    ```

4. Tap **Victor** once. Wait for two recognition → submission → completed reply → generated speech → listening cycles. Inspect `victorE2E.report()`: two successful submissions with distinct request IDs, all recorded words except “send it,” two committed user/assistant pairs, finite non-silent 24 kHz PCM, and native Web Audio completion. Both turns must use the same worker and AudioContext. All capture tracks must have ended before each synthesis/playback.
5. Replay at each offered speed. Verify `speech[].speed`, `playbacks[].playbackRate === 1`, and return to listening without extra submissions. Reload to check persistence; an invalid `pocket.victor.speed` must default to 1.25.
6. Check Victor off during generation and playback. No late result or ended event may reopen capture or play audio. Inspect `workers`, `contexts`, `tracks`, `unexpectedSpeechSynthesis`, console errors, and mobile overflow. The observer records PCM statistics, not audio buffers. Its successful `start` call measures playback scheduling, not audible output latency.
7. Call `await victorE2E.dispose()` and stop the temporary server using the PID it printed.

The fixture substitutes microphone audio only. Recognition, Kitten generation, and Web Audio playback remain real. The helper does not inject recognized text or speech output. Controller and worker regression tests separately exercise synthetic failures and stale callbacks.

## Device qualification

Physical iPhone Safari qualification remains required. Check speaker 2 audibly, microphone and playback activation, routing (including Silent mode), repeated turns, and memory survival. At 1.25×, measure generation time divided by generated audio duration on representative replies, excluding initial asset loading; the target is at most 1. Record first-audio delay separately because this implementation synthesizes a complete reply before playback. Desktop timing does not establish this phone requirement.
