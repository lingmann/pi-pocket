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
