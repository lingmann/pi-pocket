# On-device Victor MVP: validation notes

Implementation branch: `plan/on-device-voice-mvp`.

## Historical system-speech results

The [Kitten Micro validation](on-device-victor-kitten-validation.md) supersedes the system-speech checks below. These results describe the earlier implementation; the updated helper observes generated PCM and Web Audio instead of native speech events.

**The requested browser acceptance scenario passed with the user's recording and the Kroko model.** The opening words were preserved, the command submitted once, and real local TTS completed. Only model assets changed after the original model's recognition error; the architecture stayed unchanged. No physical iPhone browser qualification has been performed.

### Listening without a duration cutoff

The fixed 60-second capture deadline has been removed on `plan/on-device-voice-mvp`. Listening now continues until the trailing “send it” command, Victor off, or an existing safety interruption; silence never submits. Preparation, finalization and playback watchdogs, microphone backpressure, and visibility/ownership teardown remain unchanged.

`test/victor-listening.test.ts` first reproduced the old failure at 60,001 ms (`error` instead of `listening`), then passed with the deadline removed. It advances through six simulated minutes, verifies the draft and microphone remain active without submitting on silence, and checks exactly-once submission when “send it” finally arrives. Five additional checks retain Victor off, hidden-tab, conversation-change, driver-change and overload teardown with draft preservation. Together with the existing dictation tests: **17 passed, 0 failed**.

The real browser check used the throwaway app at 390 × 844, with the human recording delayed until 66 seconds after capture opened. At 62 seconds the microphone was still live, the worker was still running, and nothing had been submitted. The eventual command submitted `Hello there Please say the word sunshine.` once; real local system speech completed and listening resumed at about 76.9 seconds. Victor off then ended every track and terminated the worker. All 12 acceptance assertions passed, with no app/CSP console errors or horizontal overflow. An earlier attempt was interrupted by a navigation to `about:blank` and was rerun; it is not counted as a pass.

Formatting, lint, syntax and types passed. The full suite finished at **450 passed / 11 failed** (461 total). Nine assertions match the earlier clean-baseline failures: branch/worktree path spelling, goal activity ordering, phone Files-bar visibility, Alt+A focus, Pi-session model fallback, PiP checkout paths, plan-mode activity ordering, repository checkout paths, and schedule activity ordering. The held-back subagent courier and PiP approval-panel tests also failed in the full run and passed isolated reruns. The approval-panel check passed on a clean `832137b` archive too, although an earlier combined focused rerun timed out at a different step. Those two intermittent failures are not established clean-baseline failures; the full suite remains **not green**.

Detailed logs are under `/tmp/pi-pocket-voice-no-timeout/`. This establishes removal of the application’s one-minute cutoff, not indefinite iPhone memory or recognition stability. Keep the app visible and the phone unlocked; physical-device long-session qualification remains outstanding.

### Automatic-cycle UX update

The same human recording passed two consecutive turns from one Victor tap, followed by repeated Read reply playback. Both turns submitted once, retained all non-command words (punctuation varied), and returned automatically to listening after real local Samantha speech. The microphone was stopped before every playback. Read reply remained visible and usable after playback; no Listen button or manual-ready state remained. A separate replay during a spoken draft preserved the recognized text and restored it to the composer on Victor off. An injected playback failure also resumed listening with replay available.

The final mobile browser rerun passed 21 assertions, including Victor off during speech, closed capture context, ended tracks, worker teardown, no extra POSTs, and no horizontal overflow. Its console had no app or CSP errors. Eleven isolated lifecycle checks also passed for late recognition during replay, buffered commands while the mic reopens, stale microphone acquisitions, duplicate callbacks, and worklet shutdown.

Formatting, lint, and types passed. The full suite finished at **446 passed / 9 failed**: eight failure names match the recorded baseline; the newly observed restart-signal failure passed four focused reruns and remains classified as intermittent, not proven baseline. The final focused Victor checks passed **22/22** (11 lifecycle checks plus 11 existing dictation tests).

The helper now limits fixture playback to `turns` captures so automatic listening does not create an endless test conversation. Detailed reports are scratch files under `/tmp/pi-pocket-voice-cycle/`; the steps below exercise the updated flow. The original MVP results and baseline checks below describe the earlier implementation.

### Original MVP result in the built-in browser

Using the throwaway `test/serve.ts` app at a 390 × 844 viewport:

- The published sherpa runtime initialized the pinned Kroko bundle without cross-origin isolation.
- Recorded audio traversed the actual AudioWorklet and recognition worker. The capture context ran at 44.1 kHz; sherpa reported its native conversion to 16 kHz.
- The live transcript reached `Hello there Please say the word sunshine, send it`. The command finalized the stream and produced exactly one successful submission: `Hello there Please say the word sunshine,`. Every intended non-command word was retained. The model's trailing comma was not manually repaired.
- Pi Pocket committed the new user message and the scripted assistant answer through its normal API and event transport.
- The completed reply used the native **Samantha** voice with `localService === true`, with actual speech start/end events. TTS was not replaced by a stub.
- Capture tracks had ended before playback. Switching Victor off terminated the real worker and produced no additional submission.
- The page stayed within its 390 px width. No new app/CSP errors appeared in the console.

The browser is muted by its launcher. These speech events do not establish audible speaker output, iPhone routing, microphone permissions, Safari audio activation, or device memory/latency.

### Diagnosis: the original model missed the opening words

The locally synthesized phrase “Hello Pi. Send it.” produced `O PIE SEND IT` in the browser. Adding silence and waiting for the capture graph to be ready did not recover the beginning. Feeding the same file directly to the real recognizer in Node also produced `O PI SEND IT`. Native-rate synthesis and a longer sentence retained the same missing opening “Hello,” although a later “hello” was recognized.

This rules out browser capture timing as the sole explanation, but does not distinguish missing speech in the recording from a recognition error. It is **not an accuracy pass**.

The user then supplied a 6.485333-second, 48 kHz mono AAC recording. Its SHA-256 is `ea4979e2c5cacf992455e941ba09c1e9a40c60f9e74f3dba60e414131c7e66d4`. The original was left untouched and decoded to a separate 48 kHz mono PCM WAV, with no trimming. The browser recognized `ULAR PLEASE SAY THE WORD SUNSHINE SEND IT`, submitted `ULAR PLEASE SAY THE WORD SUNSHINE` once, and spoke the resulting Pi reply through the real local voice. Capture tracks were already ended at TTS start. That first model missed the opening words; no corrected transcript was substituted. Direct recognition of the original M4A and derived WAV reproduced the same text with 100 ms, 320 ms and whole-file input, with and without preroll, with greedy and beam-search decoding, and with float or quantized encoder/joiner weights. Changing those settings is not supported as a fix by these results. Larger/newer drop-in models recovered the opening from the same recording; Kroko then passed the complete browser flow. See the [model comparison](on-device-victor-model-comparison.md).

Requested phrase, recorded with silence before and after:

> Hello there. Please say the word sunshine. Send it.

The original attachment remains outside the repository. Test audio is not committed. Any conversion uses a separate PCM WAV without trimming or changing its sample rate.

### Model-comparison boundary

The user requested larger or higher-quality candidates, **without any architecture or design changes**. Comparisons are therefore limited to streaming transducer models that use the same published sherpa runtime, encoder/decoder/joiner/tokens adapter, AudioWorklet capture, keyword turn control, strict CSP and native local TTS. Moonshine and batch-only Whisper are excluded. Only model assets and supported recognizer settings may change. Asset size and desktop WASM memory measurements do not establish iPhone Safari fit or real-time speed.

## Repeat the browser acceptance scenario

Prepare the pinned assets on the server:

```sh
node scripts/prepare-victor-assets.mjs
```

Start the throwaway app with a verified WAV fixture. This creates temporary app data, not a copy of the live conversations:

```sh
POCKET_VICTOR_FIXTURE=/absolute/path/to/verified.wav \
    node test/serve.ts 8899 127.0.0.1
```

Start it in the background when using agent tools. Open the printed owner sign-in link in the built-in browser, select the seeded session, and set the viewport to mobile. The real server should be opened as `localhost` to keep its cookies separate.

Install the test-only input and observation helper with the browser's evaluate tool:

```js
window.victorE2E = await (await import("/__test/victor-input.js")).installVictorInput({ turns: 2 });
```

Then use the real controls:

1. Tap **Victor** once. Listening starts after preparation, with no Listen button.
2. The helper feeds the recording after each of the first two capture graphs connects, then supplies silence. It substitutes a microphone source, not a transcript or speech engine; `turns` defaults to one.
3. Wait for both automatic recognition → submission → final reply → local TTS → listening cycles. Check `victorE2E.report()`: two successful POSTs with distinct request IDs, every recorded word except “send it”, two committed user/assistant pairs, and local speech start/end events. Capture tracks must be ended at each speech start.
4. Tap **Read reply** twice, waiting for listening after each playback. It stays visible, becomes enabled again, and causes no further POSTs.
5. Tap **Victor** to turn it off. All capture tracks must be ended and the worker terminated. Inspect the console and mobile layout too.
6. Call `await victorE2E.dispose()` to restore native browser functions and close the fixture's own audio contexts.

Only `test/serve.ts`, when `POCKET_VICTOR_FIXTURE` is set, serves the fixture and helper. The production HTTP handler exposes neither route. Stop the temporary server using the PID it prints when done; that removes its temporary conversations.

## Repository checks

The project also requires its existing formatting, lint, type and regression checks. No new unit-test suite, benchmark or device matrix was added.

- `npm run format`, `npm run check`, and `npm run lint` have passed. Existing user changes were preserved.
- The first full `npm test` run completed with **441 passed / 14 failed**.
- Its three dock-layout regressions were fixed by moving the inactive Victor control into the existing toolbar, instead of adding a row. Those three tests, the mobile touch test, and the Pi-session picker UI test subsequently passed together: **5/5**.
- A clean-HEAD copy at `6067422` reproduced eight of the original failures with identical assertions: branches, goals, mobile Alt+A focus, Pi-session model fallback, PiP checkouts, plan mode, repository watches, and schedules. The drop-in reload failure also occurred in the baseline full run, but passed its focused reruns. Do not classify the five passing UI checks above as baseline failures.
- The clean-HEAD full run timed out; it did not produce complete suite totals.
- The final full run of the changed application code completed with **443 passed / 12 failed**. The subsequent Kroko change replaced only model data/pins and passed the real browser scenario above. The five UI checks above all passed. Nine of the remaining assertions reproduce on clean HEAD: the eight listed above plus the mobile Files bar/diff-header visibility check. The drop-in reload, PiP window sizing, and many-compactions timing checks failed in the full run but passed focused reruns on the changed checkout and baseline. The drop-in timeout also occurred during the baseline full run. The full suite is **not green**; no claim is made that all failures are fixed.

The final browser assertions are saved in `/tmp/pi-pocket-voice-mvp/human-kroko-acceptance.txt`: all 13 passed, including complete recognized words, one POST, command removal, committed entries, real local speech, microphone stopped before speech, worker teardown, and no horizontal overflow. Page-observed resource requests were same-origin; the worker also restricts asset URLs and network access to this origin. These checks do not substitute for physical iPhone validation.

Temporary detailed logs are under `/tmp/pi-pocket-voice-mvp/`. Baseline comparison and logs are under `/tmp/pi-pocket-voice-baseline.6aQjdo/`. These paths are diagnostic scratch files, not durable repository evidence; the outcomes above are retained here.
