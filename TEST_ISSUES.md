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
