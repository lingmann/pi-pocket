# Known test failures

Scope: v0.13.1 (upstream and Victor fork), macOS, Node 24.21.0, Chromium; recorded 2026-10-12. Test files are under `test/`.

**Upstream** = reproduced on the original release. **Fork only** = intermittent on Victor; upstream unverified. Evidence applies only to the release above.

| Tests                                                     | Recognizable failure                                                            | Evidence  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | --------- |
| `branches.test.ts`, `pip.test.ts`, `repo-watches.test.ts` | Path assertion: `/private/var/...` versus `/var/...`.                           | Upstream  |
| `mobile-ui.test.ts`                                       | Alt+A focus: typing stays in the session instead of PiP.                        | Upstream  |
| `providers-ui.test.ts`                                    | Timeout waiting for every model to appear.                                      | Upstream  |
| `mobile-ui.test.ts`                                       | Files bar is `hidden` instead of `visible`.                                     | Upstream  |
| `mobile-ui.test.ts`                                       | PiP header: timeout returning to the session list.                              | Upstream  |
| `pi-sessions-ui.test.ts`                                  | Picker times out waiting for “Fix the checkout total”.                          | Upstream  |
| `pi-sessions.test.ts`                                     | Compaction timing-ratio assertion, e.g. `4x` compactions took `20.8x` the time. | Fork only |
| `session-row-ui.test.ts`                                  | Worker hangs after all assertions pass.                                         | Fork only |
| `mobile-ui.test.ts`                                       | Invite closes but leaves a Files layer open.                                    | Fork only |
| `mobile-ui.test.ts`                                       | PiP positioning: timeout finding the session list.                              | Fork only |
| `dropins.test.ts`                                         | Edited drop-in reload times out.                                                | Fork only |
| `victor-cache-ui.test.ts`                                 | Chromium setup times out on `Browser.getVersion`.                               | Fork only |

## v0.13.2: macOS shortcut expectations

Observed in the rebased Victor checkout on macOS, Node 24.21.0, and Chromium. The original release has not been tested.

| Test                        | Failure signature                                                     | Evidence                                                                                                 |
| --------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `composer-focus-ui.test.ts` | First test times out waiting for the second session after Alt+number. | The browser reports `MacIntel`, so Option types into the focused composer instead of switching sessions. |
| `status-line-ui.test.ts`    | Launcher test times out waiting for the launcher after Ctrl+K.        | On an Apple keyboard the app uses Cmd+K; Ctrl+K edits text.                                              |

An isolated browser probe confirmed both behaviors with the current code. Serving `ui.js` with its platform detection forced to non-Apple made Alt+number switch sessions and Ctrl+K focus the launcher. With native `MacIntel` detection, Cmd+K focused the launcher. Use platform-appropriate shortcuts, or pin a non-Apple platform for tests of non-Apple behavior.

## v0.14.0: upstream merge validation

Observed in the merged Victor checkout on macOS, Node 24.22.0, and Chromium. The original release has not been tested; these observations do not establish upstream baseline failures.

| Tests                                                    | Failure signature                                                                                     | Evidence                                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dropins.test.ts`, `pip.test.ts`, `repo-watches.test.ts` | Path assertion: `/private/var/...` versus `/var/...`.                                                 | The assertions compare resolved paths with unresolved temporary paths. This signature also appeared in earlier releases, but the new drop-in case is specific to 0.14.0.                            |
| `launcher-ui.test.ts`                                    | Three tests time out waiting for the launcher's native input to receive focus.                        | The test's `open()` sends Control+K; on Apple platforms the app uses Command+K. No test or application fix was made.                                                                                |
| `model-scope.test.ts`                                    | Two model-count assertions report `43 !== 3`.                                                         | Both pass with `VENICE_API_KEY`, `MISTRAL_API_KEY`, and `MEGAARK_API_KEY` removed from the test process's environment. The temporary sign-in folder alone does not isolate environment credentials. |
| `linked-sessions.test.ts`                                | After a guest submits, `linkedSessions.list(target)` still returns an origin address instead of `[]`. | Repeated in a focused run with the model-provider environment keys removed. Origin title and folder are absent; guest attribution/admission timing remains unverified.                              |
| `main.test.ts`                                           | Early-restart child exits with `SIGUSR2` instead of code 75.                                          | Repeated in a focused run. On macOS the test cannot inspect `/proc`, so it sends the signal after a fixed 300 ms rather than observing handler readiness.                                           |
| `extension-loader.test.ts`                               | Owner-only reload notice times out waiting for “the failure is told”.                                 | Passed in the full run, failed in a later focused group, then passed alone. The test edits a watched file; the passing rerun does not establish a fix or cause.                                     |

## v0.16.0: New session shortcut on macOS

Observed in the merged Victor checkout on macOS, Node 24.22.0, and Chromium. The original release has not been tested.

`launcher-ui.test.ts`'s **New session here starts in the open session's folder** times out waiting for “the New session picker at the session's folder” after `Alt+n`, before opening the launcher. Desktop navigation focuses the composer (`web/composer.js`); `web/app.js` suppresses Alt shortcuts while typing on Apple platforms. This is consistent with the earlier Alt+number issue, but is a newly observed test signature. The test and shortcut implementation are unchanged by this merge.

The full run passed 750 of 758 tests. The other seven failures matched previously recorded path, launcher-focus, and early-restart signatures. No unrelated fixes or upstream comparison were performed.

## v0.19.0: linked-session paths and Cloudflare credentials

Observed in the merged Victor checkout on macOS, Node 24.22.0, and Chromium. The original release has not been tested; these observations do not establish upstream baseline failures.

| Test                                           | Failure signature                                                                                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linked-sessions.test.ts`                      | **The first linked request loads the destination's project instructions and runs tools there** compares `/private/var/.../context-destination` with `/var/.../context-destination`. | Reproduced in the full run and a focused run. This is a new occurrence of the macOS path-normalization signature, not the earlier linked-session origin-address failure.                                                                                                                                                                                                                                                                    |
| `model-refresh.test.ts`, `model-scope.test.ts` | Refresh sees `2 !== 1` providers, model scope sees `21 !== 3` models, or refresh errors unexpectedly include `cloudflare-workers-ai`.                                               | The full run already excluded `VENICE_API_KEY`, `MISTRAL_API_KEY`, and `MEGAARK_API_KEY`. Additionally excluding `CLOUDFLARE_API_KEY` made all five model tests pass. A control run retaining Cloudflare credentials reproduced the provider/model count failures; the error-list case passed in that control run. Pi AI 1.3.0 maps Cloudflare providers to this environment variable, so a temporary sign-in folder does not isolate them. |

The full run passed 792 of 805 tests. The other eight failures matched previously recorded drop-in/PiP/repository-watch path, launcher-focus/shortcut, and early-restart signatures. The credential-isolated focused run passed 15 of 16 tests, with only the linked-session path assertion still failing. No unrelated fixes or pristine-upstream comparison were performed.

## v0.20.0: platform assumptions and ambiguous UI selection

Observed in the merged Victor checkout on macOS, Node 24.22.0, and Chromium. These three failures reproduced together (16 passed, 3 failed) and again when only the failing tests were selected. Both runs excluded `VENICE_API_KEY`, `MISTRAL_API_KEY`, `MEGAARK_API_KEY`, and `CLOUDFLARE_API_KEY`. The original release has not been run separately.

| Test                                 | Failure signature                                                                                                                                | Evidence                                                                                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `composer-keys-ui.test.ts`           | **A taken app key opens neither a sheet nor the launcher, in both boxes** reports `2 !== 4`.                                                     | The test sends Control+K for `Mod+K`; unchanged `box-keys.js` maps Mod to Meta on `MacIntel`. A browser probe counted only the two Alt+N events. The intermediate location assertions read the preceding event's value.                                |
| `reveal.test.ts`                     | **The first command that works wins; a path that is not there is a 404** throws HTTP 409, “No file manager could show it”.                       | The stub fails the first command and succeeds only on a second. macOS supplies only `open -R`, so no second command exists. The test and `reveal.ts` match the incoming release.                                                                       |
| `session-list-extensions-ui.test.ts` | **An action on sessions shows in the selection bar, and gets the selected sessions** times out waiting for the action on both selected sessions. | The label selector “Note” finds a row's opacity-zero button before the selection-bar button. A browser probe recorded one ID while two remained selected. The test, `sessions.js`, and the browser selector implementation match the incoming release. |

The full-suite run left 14 unresolved failures: these three and 11 matching previously recorded path, launcher-shortcut/focus, early-restart, and extension-reload signatures. Final focused shared-submission and Victor attribution tests passed all 64 cases. The full suite was not repeated after the final focused fixes.

Repository-wide `npm run lint` also reports a missing blank line at `test/artifact-inline.test.ts:487` (`@stylistic/padding-line-between-statements`). That file is unchanged from the incoming release. Changed integration files pass lint. Whole-merge `git diff --cached --check` also reports whitespace in the incoming `IBMPlexMono-OFL.txt`, `Iosevka-OFL.txt`, and `NerdFonts-README.txt` under `web/fonts/`; those bundled files remain unchanged. No unrelated fixes or pristine-upstream comparison were performed.

## v0.21.0: rate-limit retry UI timeout

Observed in the merged Victor checkout on macOS, Node 24.22.1, and Chromium. The runs excluded `VENICE_API_KEY`, `MISTRAL_API_KEY`, `MEGAARK_API_KEY`, and `CLOUDFLARE_API_KEY`. The original release has not been run separately.

`limit-wait-ui.test.ts`'s **The live line says Pi waits for a limit and has Retry now, which sends the request** timed out waiting for “the answer” after clicking Retry now. The wait indicator and mobile layout assertions had passed. This new test and its retry implementation match the incoming release. A sequential run with the two artifact UI suites passed all 22 tests without a code change; the cause remains unverified, and that pass does not establish a fix.

The full run passed 947 tests, failed 35, and skipped 2. Of the failures, 21 came from Chromium `Browser.getVersion` timeouts in the shared setup of `artifact-bridge-ui.test.ts` and `artifact-inline-ui.test.ts`; all passed in the sequential run above. The remaining 13 failures matched previously recorded path, macOS shortcut/focus, early-restart, extension-reload, and file-manager signatures. No unrelated fixes or pristine-upstream comparison were performed. The full run began before the Victor checkpoint compatibility fix; the final focused configuration, attribution, and controller run passed all 148 tests, including the new checkpoint/restart and long-wait cases.

## v0.23.0: artifact viewer notice timeout

Observed in the merged Victor checkout on macOS, Node 24.22.1, and Chromium. The full suite used `--test-concurrency=2` and excluded `VENICE_API_KEY`, `MISTRAL_API_KEY`, `MEGAARK_API_KEY`, and `CLOUDFLARE_API_KEY`. The original release has not been tested separately.

`artifact-bridge-ui.test.ts`'s **a viewer gets a notice, not a message** timed out waiting for “the notice” after tapping the artifact iframe. The test expects a viewer-only refusal containing “you can only view here”. The test, `web/artifact-bridge.js`, and `src/server/http/artifacts.ts` are unchanged by this merge. An isolated rerun of this test passed without a change; its cause remains unknown, and that pass establishes neither a fix nor an upstream baseline failure.

The full run passed 1065 tests, failed 12, and skipped 2 process-lock checks. All Victor tests and extension-loader tests passed. The other 11 failures matched the recorded macOS path, composer-key, launcher-focus/shortcut, and file-manager signatures. The full suite began before the final check-only updater timer fix; the final `victor-updates.test.ts`, `updates.test.ts`, and `updates-routes.test.ts` group passed all 38 tests. The full suite was not repeated after that focused fix. No unrelated fixes or upstream comparison were performed.

## v0.24.0: artifact follow-up and preview timeouts

Observed in the merged Victor checkout on macOS, Node 24.22.1, and Chromium. The full suite used `--test-concurrency=2` and excluded `VENICE_API_KEY`, `MISTRAL_API_KEY`, `MEGAARK_API_KEY`, and `CLOUDFLARE_API_KEY`. The original release has not been tested separately.

| Test                         | Failure signature                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `artifact-bridge-ui.test.ts` | **A tap's follow-up joins the draft** times out waiting for “the follow-up in the box”.              |
| `artifact-inline-ui.test.ts` | **A running card gets the artifact bridge** times out waiting for “the follow-up”.                   |
| `artifact-inline-ui.test.ts` | **An update adds a card; the earlier card keeps its version** times out waiting for “both previews”. |

The complete artifact bridge and inline suites then passed separately without a code change: 10 and 11 tests respectively. These passing reruns establish neither a fix nor a cause. Both test files, `web/artifact-bridge.js`, `web/rich.js`, and `src/server/http/artifacts.ts` are unchanged by this merge and match the incoming release. No pristine-upstream comparison or unrelated fix was performed.

The full run passed 1119 tests, failed 14, and skipped 32. All Victor tests passed, including the new queued background-completion style regression. The other 11 failures matched recorded macOS path, composer-key, launcher-focus/shortcut, and file-manager signatures. Linux background-process cases and 2 process-lock checks were skipped on this host. A separate final reply-style run passed all 22 tests.

A filtered client browser group (`clock-ui.test.ts`, `launcher-ui.test.ts`, and `victor-composer-ui.test.ts`) emitted 11 passes, then reached its 180-second command timeout without a final summary. No matching child or browser remained afterward; its cause is unverified. The full suite subsequently completed with no Victor or clock failures.

## v0.25.0: background-card tests require Linux

Observed in the merged Victor checkout on macOS, Node 24.22.1, and Chromium. The full suite used `--test-concurrency=2` and excluded `VENICE_API_KEY`, `MISTRAL_API_KEY`, `MEGAARK_API_KEY`, and `CLOUDFLARE_API_KEY`. The original release has not been tested separately.

Both tests in `background-ui.test.ts` time out waiting for “the background card”: **a background task's end shows as a card with its last lines** and **output whose own line says it is the end is not taken for a cut one**. Both failures repeated in a focused run. Their fixture starts real background commands but checks only for Chromium, unlike `background.test.ts`, which skips when `/proc/self/stat` is absent. A separate isolated-app assertion confirmed that starting the fixture's `seq 1000 1200` command rejects with “Background tasks need Linux”. The new browser tests and `src/server/background.ts` match the incoming release; this is evidence of a platform mismatch, not a pristine-upstream test result. No test or application fix was made.

The full run passed 1133 tests, failed 15, and skipped 33. All Victor tests passed. The other 13 failures matched recorded macOS path, composer-key, launcher-focus/shortcut, file-manager, artifact-viewer notice, and rate-limit retry timeout signatures. The skipped cases were 31 Linux background-process checks and 2 process-lock checks. No unrelated fixes or pristine-upstream comparison were performed; Linux execution and physical-device audio remain untested.
