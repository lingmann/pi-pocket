# Victor Voice state machines

This is the single state-machine inventory and local issue ledger for Victor Voice. It covers the browser controller, composer handoff, speech worker/worklet, asset loading and caching, and durable reply style. It does not model the entire upstream agent scheduler, browser audio implementation, or fork release tooling. The [source map](victor.md#source-files) identifies those boundaries.

The audit started from fork main `54be8820f459aa7921710340e41437af1c3a9b75` (incorporating upstream 0.28.0). Tables describe the intended transitions; the issue ledger identifies reproduced violations and their repair status. Names in backticks are implementation fields or functions; descriptive names such as “opening capture” are implicit states, not new enums. Tests exercise real application logic, with controllable network, browser-audio, and native-engine boundaries. They do not qualify physical-device audio.

## Cross-machine invariants

1. **Ownership outlives audio.** Every phase except `off`, including `error`, owns the draft and blocks ordinary dictation. An owner must still observe page departure and conversation/permission changes after its audio resources are released. Returning unsent text happens before a departing page can lose it. See VSM-1.
2. **No automatic duplicate.** The composer copy is consumed synchronously before POST. Once delivery might have happened, neither disable nor an uncertain response restores a sendable copy. Only a definite rejection restores it. Victor never retries a POST automatically.
3. **Separate lifetimes.** `delivery` survives local teardown; `pending` does not. Thus `off + deliveryPending` and `error + deliveryPending` are valid, not contradictions. An unresolved POST blocks activation tab-wide and ordinary Send only in its originating conversation.
4. **Half duplex.** Capture is disconnected before synthesis/playback. Replaying keeps the unfinished recognition stream but stops microphone capture. Cues do not enter the capture graph.
5. **Stale work cannot revive ownership.** `epoch` invalidates worker, context, and HTTP continuations; `captureId` invalidates acquisitions/worklet callbacks; `turn` filters recognition results; `speechId` plus epoch and stage identifies synthesis/playback completion. HTTP settlement may release the delivery guard and restore a rejected draft, but cannot restart audio after teardown.
6. **Attribution is conservative.** An accepted POST alone is insufficient for speech. Require one matching user message after the activation/previous-reply boundary, our author attribution, an idle run, an empty queue, and a completed speakable answer. Competing exchanges stop Victor.
7. **Retries reuse only healthy state.** Fatal WASM failures require a new worker. Recoverable synthesis/playback failures may reuse the runtime. Failed service-worker registration must not become a permanent successful-looking memo. See VSM-2.
8. **Durable source precedes admission.** The first recorded input source wins for a request ID, even if admission later fails. Queued inputs do not affect reply style until placed in the active run. Source/settings persistence is independent of the browser microphone toggle.

## 1. Controller phase and ownership

Source: [`web/victor-mode.js`](../web/victor-mode.js), `enable`, `hear`, `listen`, `submitFinal`, `reconcile`, `finishReply`, `fail`, `disable`; presentation: [`web/victor-controls.js`](../web/victor-controls.js).

| Explicit phase | Meaning and valid resources                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`          | No owner, draft, audio, worker, or lifecycle subscription. A previous POST may still be unresolved.                                                             |
| `preparing`    | Owner and unsent starting draft; context created on the user's tap; waiting for worker control/model initialization. No capture.                                |
| `listening`    | Owner and unsent draft; includes microphone acquisition and cues before capture actually connects. Ready runtime; no active speech.                             |
| `submitting`   | First flush/final recognition, then optionally HTTP delivery. These are distinct substates; the phase alone does not say whether text was sent.                 |
| `waiting`      | POST accepted; no unsent submitted copy or capture. `pending` tracks the exchange and attribution.                                                              |
| `speaking`     | Generating or playing audio, not necessarily audible yet. May be the submitted answer or replay over an unfinished draft.                                       |
| `error`        | Audio/worker/timers released, but owner and any unsent draft remain. Dictation stays blocked; user or lifecycle change must still be able to release ownership. |

| From                                | Event / guard                                                                                                                                                 | To / effects                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `off`                               | Enable; connected selected idle main session, model, sending rights/driver, empty queue, no pending delivery; plain valid draft; secure browser audio support | `preparing`; capture owner, history boundary, stream identity and permissions; block dictation; start 180-second preparation deadline |
| `off`                               | Eligibility/capability failure                                                                                                                                | `off`; notice, no handoff consumption                                                                                                 |
| Any active phase                    | Enable again                                                                                                                                                  | Unchanged                                                                                                                             |
| `preparing`                         | Current worker `ready`, once                                                                                                                                  | `listening`; clear preparation deadline, start recognition turn and microphone acquisition                                            |
| `listening`                         | Revised partial                                                                                                                                               | Update only new speech; retain starting text                                                                                          |
| `listening`                         | New speech ends with “send it” and capture is connected                                                                                                       | `submitting`; flush capture, start 15-second finalization deadline                                                                    |
| `submitting`, before POST           | Final transcript lacks command / validation or consume fails                                                                                                  | `error`; retain unsent draft, no POST                                                                                                 |
| `submitting`, before POST           | Final command leaves no non-whitespace text                                                                                                                   | `listening`; new ASR turn, no POST                                                                                                    |
| `submitting`, during POST           | Success, activation still current                                                                                                                             | `waiting`; clear displayed draft, reconcile accepted text/attribution                                                                 |
| `waiting`                           | Attributable completed answer                                                                                                                                 | `speaking`, or `listening` with warning for an unspeakable answer                                                                     |
| `waiting`                           | 30-second reply check while run busy, including provider retry/limit wait                                                                                     | `waiting`; rearm check, do not resubmit                                                                                               |
| `waiting`                           | Reply check while idle without attributable completion                                                                                                        | Clear pending exchange, warn, attempt `listening`; a nonempty queue still rejects that attempt                                        |
| `listening`                         | Read reply; cached reply and still eligible                                                                                                                   | `speaking`; pause capture, keep draft and ASR turn                                                                                    |
| `speaking`                          | Playback ends, ordinary synthesis/playback error, or playback watchdog                                                                                        | Attempt `listening`; replay resumes same turn, first playback starts a new turn                                                       |
| Any active phase                    | Fatal runtime/audio failure, preparation/finalization/synthesis timeout                                                                                       | `error`; invalidate asynchronous audio work; retain ownership and lifecycle guards                                                    |
| Any active phase, including `error` | Off, hidden/pagehide, adapter unmount, changed conversation/connection/permissions/history, competing exchange                                                | `off`; return only unsent draft, release ownership and dictation block; never abort Pi                                                |
| `off` or `error` after teardown     | Stale worker/capture/speech event                                                                                                                             | Ignore; no microphone revival                                                                                                         |

Controls derive `active` from phase, `hasReply` from `lastReply`, and `deliveryPending` from `delivery`; they are projections, not independent machines. Speed is one of 0.75, 1, 1.25, 1.5, defaults to 1.25, persists best-effort, and is captured per synthesis request.

## 2. Draft handoff and delayed editors

Sources: [`web/victor-composer.js`](../web/victor-composer.js), `toggle`, `mount`, `editGuard`; [`web/composer.js`](../web/composer.js), `toggleVictor`, quote/queued-edit/insertion effects; [`web/person-storage.js`](../web/person-storage.js).

States: **composer-owned**, **handed-off unsent**, **consumed**, **restored**, and an orthogonal **mounted/unmounted** observer. `ownedDraft` is the last stored predecessor belonging to the handoff; `handoff` is a monotonically increasing editor generation. Recognition's `startingText` is immutable for a turn; `recognizedText` is replaceable.

| From                                                  | Event / guard                                                   | To / effects                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Composer-owned                                        | Toggle fails controller/sending/attachment guard                | Unchanged; do not take draft                                                                               |
| Composer-owned                                        | Toggle passes guards                                            | Increment editor generation; stop dictation, expand folded pastes, supply callbacks to controller          |
| Handed-off unsent                                     | Partial/final recognition                                       | Combined starting text + separator + revised speech; imported “send it” never triggers submission          |
| Handed-off unsent                                     | Consume; storage still equals `ownedDraft`                      | Consumed; synchronously clear stored draft and paste mappings before POST                                  |
| Handed-off unsent                                     | Consume; storage changed elsewhere                              | Reject consumption; no POST; later preservation keeps both edits                                           |
| Handed-off unsent / consumed after definite rejection | Preserve                                                        | Replace owned predecessor/empty draft, otherwise append to newer expanded text; notify only mounted origin |
| Any handoff                                           | Origin unmounts while active                                    | Disable before forgetting owner; stored restoration outlives component                                     |
| Active                                                | Quote, queued-edit response, or shared insertion needs composer | Disable first, then merge ordinary text/files/quote through upstream paths                                 |
| Captured editor guard                                 | Any subsequent handoff, even one already stopped                | Permanently invalid; delayed shortcut cannot overwrite speech                                              |
| Person storage available                              | Sign-out/account change                                         | Storage clears/locks; a different account requires a fresh document, not rebinding old draft callbacks     |

Invariants: preserve expanded untrimmed text; never clear newer typing; do not copy quote/attachment/paste formats into Victor. Error ownership is not proof that the recognized draft has reached persistent storage (VSM-1).

## 3. Submission and response settlement

Source: [`web/victor-mode.js`](../web/victor-mode.js), `submitFinal`; shared HTTP boundary: [`web/store.js`](../web/store.js), `api`.

States: **no attempt**, **finalizing** (`flushing`, no `pending`), **in flight** (`delivery === pending`, `accepted=false`, `unsent=false`), **accepted** (`delivery=null`, `pending.accepted=true`), **rejected**, **uncertain**, and **detached in flight** (owner released but `delivery` retained).

| From                   | Event / guard                             | To / effects                                                                                                            |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Finalizing             | Valid nonempty final text; draft consumed | In flight; fresh request ID, `source:"victor"`, `mode:"followUp"`, no attachments/inline files                          |
| In flight              | Duplicate final result                    | Ignore because `pending` exists; one POST                                                                               |
| In flight              | Disable, navigation, or fatal audio error | Detached in flight; no automatic draft return                                                                           |
| In flight              | HTTP success, current epoch               | Accepted; adopt string `acceptedText` if supplied; reconcile only now against prepared text                             |
| Detached in flight     | HTTP success                              | Release send guard; do not speak or reopen capture                                                                      |
| In flight              | HTTP 4xx                                  | Rejected; restore unsent status, enter error; off/lifecycle returns text                                                |
| Detached in flight     | HTTP 4xx                                  | Restore captured draft through original adapter callback; retain newer typing; release guard even if restoration throws |
| Either in-flight state | Network error or non-4xx failure          | Uncertain; warn, release guard, do not restore submitted text                                                           |
| Rejected / uncertain   | User tries again                          | No automatic retry; user reviews conversation and explicitly sends a new message                                        |

The 4xx classification is the current client contract, not proof against arbitrary proxies lying about delivery. There is no POST watchdog: an unresolved fetch retains the guard. Reload loses this in-memory delivery record. Neither case authorizes automatic resubmission.

## 4. Reply attribution and provider retries

Source: [`web/victor-mode.js`](../web/victor-mode.js), `reconcile`, `checkReply`, `finishReply`.

States: **observing boundary without pending input**, **awaiting acceptance**, **awaiting attribution/completion**, **claimed once** (`pending.spoken`), **finished**. The owner's boundary is the last entry at activation or after finishing its exchange.

| State                           | Observed event / guard                                                                        | Transition                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Any owned state                 | Wrong connection/conversation, stream generation, permission key, or missing history boundary | Off; never infer ownership across reconnect/history replacement          |
| No pending input                | New user message, busy run, or queued input                                                   | Off; another exchange started                                            |
| Pending input                   | More than one new user; known foreign author; reset entry; accepted text mismatch             | Off; ambiguous exchange                                                  |
| Awaiting acceptance             | Transcript arrives before HTTP result                                                         | Wait; do not compare raw local secrets with server-redacted text yet     |
| Awaiting attribution/completion | No user, unknown author, busy run, or queue not empty                                         | Wait                                                                     |
| Awaiting attribution/completion | Exactly one matching own user; idle/empty queue; later assistant entry                        | Claim once, clear reply timer                                            |
| Claimed                         | Error, stop reason other than `stop`/`length`, or no speakable text                           | Finish without speech; warn, advance boundary                            |
| Claimed                         | Speakable answer                                                                              | Save sanitized text, synthesize once                                     |
| Waiting                         | Provider retry/backoff keeps `view.live.busy=true`                                            | Repeat 30-second checks indefinitely; no new POST, capture, or synthesis |
| Finished                        | Playback/recoverable speech error                                                             | Clear pending, advance boundary, listen again                            |

Speech extraction removes code blocks and unsafe markup, retains readable text, and does not alter the transcript. Matching text plus attribution is intentionally conservative, not a request-ID proof: `acceptedText` on a manually reused request ID describes current preparation, not necessarily the original stored submission. The shipped controller uses fresh IDs and does not retry.

## 5. Microphone, cues, and PCM flow control

Sources: [`web/victor-mode.js`](../web/victor-mode.js), `listen`, `openCapture`, `recordingCue`, `stopCapture`; [`web/victor-capture-worklet.js`](../web/victor-capture-worklet.js).

Controller substates: **stopped**, **opening** (resume, microphone, worklet module), **waiting for cues**, **capturing**, **flushing**. Worklet substates: **buffering**, **stopped after flush**, **stopped after discard**, **overloaded**. Its counters are `used` and `pending`.

| From                 | Event / guard                                          | To / effects                                                                                                      |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Stopped              | Listen                                                 | New `captureId`; fresh ASR turn unless replay resume; acquire mono/echo-cancelled microphone                      |
| Opening              | All promises finish and epoch/capture ID still current | Wait for prior falling cue, then rising cue; require running context before connecting capture                    |
| Opening / cues       | Stale acquisition resolves                             | Stop its tracks; never install it in the new capture                                                              |
| Opening              | Current acquisition/resume/module failure              | Controller error, retain unsent draft                                                                             |
| Capturing            | Audio render quantum                                   | Average channels into roughly 100 ms mono batches; output remains silent                                          |
| Buffering            | Batch fills, within budget                             | Transfer PCM; increase pending; worker receives audio for current ASR turn                                        |
| Buffering            | More than approximately two seconds unacknowledged     | Overloaded; report error, stop, discard buffered samples                                                          |
| Capturing / flushing | Worker decoded batch and sends ack                     | Decrease controller backlog, relay sample count to current worklet                                                |
| Capturing            | Spoken command                                         | Flush; worklet stops accepting input, sends final short batch, then `flushed`                                     |
| Flushing             | `flushed` marker                                       | Disconnect/stop tracks and worklet, falling cue, then worker `finish`; FIFO preserves audio-before-final ordering |
| Any capture substate | Replay / disable / failure                             | Increment capture ID before stopping tracks; discard short buffer; stale port and ended events ignored            |
| Capturing            | Current track ends or context stops running            | Error; no silent continued capture                                                                                |

Invariants: one current capture graph; no microphone monitoring through speakers; bounded unacknowledged PCM. Worklet ack counts represent decoded audio, not merely main-thread receipt. Browser permission prompts have no separate timeout; users may turn Victor off while acquisition is pending. Cues have a 500 ms fallback and cannot strand teardown.

## 6. Worker initialization, recognition, and synthesis

Source: [`web/victor-worker.js`](../web/victor-worker.js).

Runtime states: **new**, **initializing**, **ready**, **fatal**, **terminated**. ASR states: **no stream**, **active turn**, **finishing**. TTS generation is synchronous inside the worker, serialized with ASR messages, not a second concurrently executing WASM engine.

| Machine / from         | Input / guard                                           | To / effects                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime new            | `init`                                                  | Memoize initialization; fetch schema-2 manifest, validate paths/configuration, import runtime and ASR wrapper                                                          |
| Initializing           | Assets validated/downloaded                             | Construct ASR before importing TTS wrapper (both define `freeConfig`); verify pronunciation pack length/hash, mount shared byte views, construct expected Kitten voice |
| Initializing           | Both engines ready                                      | `ready`; controller may start recognition                                                                                                                              |
| Initializing           | Repeated `init`                                         | Same promise, not another runtime; controller ignores repeated ready notifications                                                                                     |
| Any live runtime       | Init/ASR error, WASM trap/abort, unknown protocol input | Fatal once; post error, ignore further messages; retry requires new worker                                                                                             |
| ASR no stream / active | Valid `start(turn,sampleRate)`                          | Free previous stream; create new one; emit `started`                                                                                                                   |
| ASR active             | Matching nonempty audio batch, at most one second       | Feed native resampler/decoder, emit changed partial, ack decoded batch                                                                                                 |
| ASR active             | Wrong-turn audio                                        | No decoding; ack still emitted, controller filters stale turns                                                                                                         |
| ASR active             | Matching `finish`                                       | Add one second right-context silence, mark input finished, drain, free stream, emit final                                                                              |
| ASR active             | Matching `discard`                                      | Free stream, no final                                                                                                                                                  |
| Runtime ready          | `synthesize`                                            | Validate ID/text, complete trailing punctuation, generate speaker 2 at offered speed and 24 kHz                                                                        |
| TTS generation         | Valid finite nonzero PCM                                | Copy independent buffer, transfer `synthesized`                                                                                                                        |
| TTS generation         | Ordinary generation/validation error                    | `synthesis-error`; retain runtime and unfinished ASR stream for retry                                                                                                  |
| TTS generation         | WASM trap/abort                                         | Fatal; never advertise a recoverable utterance failure                                                                                                                 |
| Any                    | Controller release                                      | Worker terminated; its allocated runtime/streams/files cannot be reused                                                                                                |

The controller does not explicitly wait for `started`: `start` is synchronous and posted before PCM on the same worker channel, so FIFO is the actual ordering guarantee. Audio/finish validation failures are fatal; treating them as ordinary synthesis errors would leave a damaged recognizer reusable.

## 7. Speech request and replay

Source: [`web/victor-mode.js`](../web/victor-mode.js), `speakReply`, `playReply`, `currentSpeech`, `completeSpeech`, `stopSpeech`.

States: **none**, **generating**, **playing**, **completed/cancelled**. Each request captures `{id, token, resume, stage}`; `resume` distinguishes replay from first playback.

| From                                        | Event / guard                                            | To / effects                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| None                                        | New attributable reply / eligible Read reply             | Stop capture; new speech ID; snapshot speed; generating                                                               |
| Generating                                  | Matching synthesized result                              | Clear synthesis deadline; validate nonempty finite nonzero Float32 PCM at 24 kHz; create/start buffer source; playing |
| Generating                                  | Matching ordinary synthesis error                        | Complete once, warn, resume listening; cached reply remains available                                                 |
| Generating                                  | Deadline (30–180 seconds, length/speed dependent)        | Fatal error; terminate possibly blocked worker, no in-worker retry                                                    |
| Playing                                     | Current node ends                                        | Complete once; resume capture                                                                                         |
| Playing                                     | Duration + 10 seconds watchdog / start or buffer failure | Stop playback, warn, resume listening; permit Read reply                                                              |
| Generating / playing                        | Interrupted context / fatal worker error                 | Error; release runtime                                                                                                |
| Any request                                 | Stop/cancel                                              | Clear `activeSpeech` before stopping node; remove ended handler, disconnect, clear buffer and timers                  |
| Completed/cancelled or wrong ID/stage/epoch | Late PCM/error/ended callback                            | Ignore; cannot finish a newer request                                                                                 |

Replay retains unfinished draft/ASR turn and can accept already queued partials. A late “send it” partial during replay is not sent until reopened capture exists and can flush. Synchronous worker FIFO means old audio acknowledgments precede the synthesized response; they do not become acknowledgments for the newly opened capture after that response.

## 8. Service-worker registration and control wait

Source: [`web/service-worker.js`](../web/service-worker.js); callers: app startup, Victor activation, notifications. Registration and page control are separate states.

States: **unsupported/insecure**, **unregistered**, **registering**, **registered**, **failed/retryable**; independently **uncontrolled/controlled**, with per-caller **waiting/finished** control waits.

| From                  | Event / guard                               | To / effects                                                                              |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Unsupported/insecure  | Register/wait                               | Null/no wait; speech can use network fallback                                             |
| Unregistered / failed | Register                                    | One shared registration promise                                                           |
| Registering           | Another caller                              | Share attempt, do not register twice                                                      |
| Registering           | Success                                     | Memoized registration; later callers reuse it                                             |
| Registering           | Reject or synchronous throw                 | Resolve null for this attempt, clear memo so a later activation/caller can retry (VSM-2)  |
| Uncontrolled          | Victor waits                                | Observe `controllerchange`, invoke registration; wait at most 1500 ms                     |
| Waiting               | Controlled, registration failed, or timeout | Remove listener/timer, settle wait; speech initialization continues, even without caching |
| Controlled            | Victor waits                                | No wait                                                                                   |

A timeout does not cancel an in-progress browser registration. Disabling Victor while waiting invalidates the later worker-start continuation using epoch. Registration success is not the same as controlling the page.

## 9. Versioned asset cache

Source: [`web/victor-cache.js`](../web/victor-cache.js), dispatched by [`web/sw.js`](../web/sw.js).

Per-bundle setup states: **unseen**, **opening**, **open handle**, **open failed**; global `victorCacheSetup` serializes cleanup/opening. `victorBundles` remembers cleanup attempts; handles can become **detached** when another bundle deletes the named cache. Per-request states: **lookup**, **network**, **write pending**, **done**.

| From                                  | Event / guard                                               | To / effects                                                                                                |
| ------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Unseen bundle                         | Same-origin versioned GET, not Range                        | Serialize setup; once per bundle attempt deleting other Victor caches, then open cache                      |
| Opening                               | Concurrent assets for same bundle                           | Share setup promise                                                                                         |
| Opening                               | Storage open fails                                          | Return null, forget failed handle; retry open on later request without repeating cleanup                    |
| Open handle                           | Cache hit                                                   | Return cached response/headers                                                                              |
| No handle / cache miss / read failure | Request                                                     | Fetch with `cache:"no-store"`; storage failure does not prevent speech                                      |
| Network                               | Successful, nonpartial, nonredirected response              | Return network response immediately; clone/write under event lifetime                                       |
| Write pending                         | Success                                                     | Completed asset reusable; interrupted bundle retries only missing assets                                    |
| Write pending                         | Quota/body/clone/storage failure                            | Ignore caching failure; never withhold network response                                                     |
| Open handle                           | Another bundle setup retires its named cache                | Existing handle may serve in-flight/old-bundle requests, but writes do not recreate the deleted named cache |
| Any                                   | Manifest, app/API, foreign-origin, non-GET or Range request | Not handled by Victor cache                                                                                 |

Cleanup is best effort, not a hard single-cache quota. Failed deletion or reopening a previously failed old bundle may leave multiple named caches. There is no cross-request download deduplication: simultaneous misses can fetch the same asset twice. Those are limits, not evidence of a corrupted state. A service-worker restart forgets handles/setup bookkeeping, not completed Cache Storage entries.

## 10. Asset preparation and HTTP serving

Sources: [`scripts/victor/prepare-victor-assets.mjs`](../scripts/victor/prepare-victor-assets.mjs), [`src/server/http/victor-assets.ts`](../src/server/http/victor-assets.ts).

Preparation states: **unchecked**, **verified reusable**, **staging**, **blobs installed**, **receipt published**, **manifest published**, **failed**. Server states: **bundle unknown**, **valid manifest retained**; each requested blob can independently be present or unavailable.

| From                    | Event / guard                                                         | To / effects                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unchecked               | Builder/source receipt, manifest digest/layout, and every blob verify | Reuse output; no downloads                                                                                                                                                 |
| Unchecked               | Verification fails                                                    | Unique staging directory; download pinned archives, verify hashes/layout, extract/pack/validate                                                                            |
| Staging                 | Build succeeds                                                        | Atomically rename content-addressed blobs into bundle directory                                                                                                            |
| Blobs installed         | Publish receipt, then manifest                                        | Manifest becomes visible only after all referenced blobs exist                                                                                                             |
| Any build stage         | Failure                                                               | Remove this staging directory; keep prior manifest unless publication already succeeded; next run verifies rather than trusting partial output                             |
| Concurrent preparations | Same/different valid source snapshots                                 | Independent staging; content-addressed blobs; last manifest rename wins. Interleaved receipt/manifest may require a later rebuild, not expose half-built manifest contents |
| Server bundle unknown   | Request, valid manifest                                               | Retain first valid manifest until process restart                                                                                                                          |
| Server bundle unknown   | Missing/invalid manifest                                              | 503; later requests retry loading; ordinary app remains usable                                                                                                             |
| Retained manifest       | Allowlisted blob exists with expected size                            | GET/HEAD response with immutable caching/ETag; exact conditional ETag yields 304                                                                                           |
| Retained manifest       | Unknown path / missing or wrong-size blob                             | 404 / 503; do not swap manifest silently                                                                                                                                   |
| Retained manifest       | New manifest published on disk                                        | Continue old bundle until restart; old bundle directories are retained                                                                                                     |

Preparation verifies hashes; the HTTP handler checks size/layout, not a full blob digest on every request. Worker pronunciation-pack verification adds a client-side integrity check. This is not protection against an attacker rewriting the trusted checkout.

## 11. Durable input source and reply-style selection

Sources: [`src/server/victor-replies.ts`](../src/server/victor-replies.ts), [`src/server/commands.ts`](../src/server/commands.ts), `recordInputSource`, `copyInputSources`, `victorReplyMode`; [`src/server/docs.ts`](../src/server/docs.ts), `InputSourceDoc`.

Per-request states: **unrecorded**, **reserved text/victor**, **admitted**, **placed**, **settled**; legacy admitted requests may have no source record. Source is immutable even though submission placement changes.

| From                           | Event / guard                                                    | To / effects                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Unrecorded                     | Valid submit preparation                                         | Reserve source in a transaction before admission; canonical request ID includes person                                                       |
| Reserved                       | Same request ID retried/concurrent request with different source | First committed source remains; admission deduplicates by request ID                                                                         |
| Reserved                       | Admission fails/crash before admission                           | Unused reservation may remain; retry cannot relabel it                                                                                       |
| Legacy admitted without source | Retry tries Victor tag                                           | Leave unrecorded; default text, not retroactive voice                                                                                        |
| Admitted queued                | Current run continues                                            | Source has no effect on current prompt                                                                                                       |
| Queued / steering              | Input placed in active run                                       | Latest `LiveDoc.run.inputs` entry determines mode; last input in an admitted batch wins                                                      |
| Active run                     | Tool rounds, compaction, provider retry, restart                 | Re-read durable latest placed input/source; microphone state is irrelevant                                                                   |
| Queued                         | Composer or queued-message Interrupt                             | Copy retained queue sources, and the selected input's source when moving it, to replacement IDs in the interrupt task's creation transaction |
| Queued                         | Stop                                                             | Copy sources to held request IDs in the transaction that holds the messages; explicit Send later preserves style                             |
| Any                            | Main-session lookup with no input/request/source                 | Text reset                                                                                                                                   |
| Any                            | PiP/subagent/out-of-scope lookup                                 | No Victor section                                                                                                                            |
| Any                            | Source lookup fails without cancellation                         | Normal-chat reset, not a previously cached voice restriction                                                                                 |

No source kind, version, scope, or fork policy changes are needed for these repairs. Forked histories have empty source records and therefore default to text unless new inputs are tagged.

## 12. Reply-style settings and extension lifecycle

Sources: [`src/server/extensions/victor-reply-style.ts`](../src/server/extensions/victor-reply-style.ts); shared durable commands: [`src/server/extension-commands.ts`](../src/server/extension-commands.ts).

Settings states: **default** (no override), **custom valid**, **invalid stored override**, **read unavailable**. Registration is independently **enabled/disabled/reloaded**. Commands have durable **created**, **started**, **result memoized**, **terminal** states.

| From                    | Event / guard                                          | To / effects                                                                                                                  |
| ----------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Default/custom          | Owner `set`, trimmed nonempty text ≤3900 JS code units | Commit custom override instance-wide; next request preparation reads it                                                       |
| Default/custom          | Owner `reset`                                          | Delete override; default                                                                                                      |
| Any settings            | Invalid action/value or unauthorized caller            | No settings mutation; report failure                                                                                          |
| Any settings            | `show`                                                 | Card with effective instruction; invalid stored override explicitly reports default fallback; failed read fails command       |
| Voice mode              | Valid settings                                         | Render custom/default voice instruction                                                                                       |
| Voice mode              | Invalid stored override/read failure                   | Warn, render code default; never retain earlier custom instructions                                                           |
| Text mode               | Any settings                                           | Fixed normal-chat reset; do not apply voice override                                                                          |
| Enabled                 | Disable/reload                                         | Remove/replace command and prompt section; durable override remains; already running handler may finish under original module |
| Concurrent set/reset    | Commits                                                | Commit order determines final setting                                                                                         |
| Created/started command | Duplicate request delivery                             | Find same durable task, not another write                                                                                     |
| Started command         | Restart before result memoized                         | Mark interrupted; do not rerun handler because it may already have committed                                                  |
| Result memoized         | Task replay/restart                                    | Reuse result; card uses deduplicated write ID; finish task                                                                    |

Settings and source documents checkpoint after 64 deltas. Existing tests cover repeated writes, reopen, source retries, and configuration delivery deduplication. Settings changes do not alter a provider request already prepared, and are not a secret store.

## Confirmed issues, ordered by impact

These are local issue groups, not published tracker issues. Only reachable failures with a failing regression are included. Baseline logs in `.plans/` are temporary; the commands, assertion differences, and test names below are the durable evidence.

### VSM-1 — P1: preserve draft ownership guards after audio failure

**Status: fixed and regression-tested.** Potential loss of unsent recognized text on page departure/reload after a routine microphone/runtime failure. Also leaves error ownership active after connection/permission changes.

**Reachable sequence before repair:** activate with `Typed` → recognize `unfinished speech` → worker error (or audio failure) → `fail()` → `release()` removes `visibilitychange`, `pagehide`, and store subscription but retains owner/unsent text → pagehide/hidden or ownership change no longer calls disable. Storage still contains only `Typed`. An explicit Off click works, which hid this hole in existing failure tests.

**Evidence:** `node --test --test-name-pattern='errors retain lifecycle' test/victor-mode.test.ts` failed for all eight lifecycle changes (navigation, hidden, pagehide, disconnect, reconnect, role, session access, driving turn): actual phase `error`, expected `off`. `node --test --test-name-pattern='leaving an errored' test/victor-composer-ui.test.ts` failed in an isolated Chromium app: actual persisted draft `Typed`, expected `Typed unfinished speech`.

**Fix:** moved lifecycle unsubscription from `release()` to `disable()`. Error releases worker/audio/timers immediately but keeps ownership guards. Regressions cover eight lifecycle changes, pagehide followed by a real composer reload, repeated off, and a definite POST rejection after error/pagehide. Existing stale-callback and uncertain-delivery tests remain green. No automatic retry or uncertain draft restoration was added.

### VSM-2 — P2: make failed registration retryable without duplicating concurrent attempts

**Status: fixed and regression-tested.** A transient first `/sw.js` registration failure disables registration-based asset caching for the rest of the page lifetime. Later Victor activations can keep loading large assets without Victor's persistent cache; shared notification/share registration also cannot recover through another call.

**Reachable sequence before repair:** app startup calls `registerWorker()` → browser registration rejects/throws → `registering` becomes a fulfilled promise containing null → later Victor activation calls `waitForWorkerControl()` → `registerWorker()` reuses null instead of registering again. Failure settles the wait quickly, so it is not a timeout or missing controller event.

**Evidence:** `node --test test/victor-registration.test.ts` failed in both rejection and synchronous-throw cases: observed one register call, expected two after a later attempt. Tests also require concurrent retry callers to share the new promise and reuse successful registration afterward.

**Fix:** rejected registration clears `registering`; synchronous failure returns null without memoizing it. In-flight and successful attempts still share one promise, and control waits retain their 1.5-second deadline. Both retry regressions now pass. The existing shared failure test now expects another attempt instead of asserting sticky failure. No background retry loop or notification-permission dependency was added.

## Investigated interleavings that are not confirmed bugs

- **Late microphone/worker/ended callbacks:** epoch, capture ID, speech ID/stage checks prevent old work from opening or closing a newer activation. Existing controller tests deliberately deliver those callbacks after cancellation.
- **Duplicate final results and uncertain sends:** `pending` suppresses duplicate finals; `delivery` outlives disable; 5xx/network failures do not restore a sendable copy. Fresh activation remains blocked until the old POST settles.
- **Reply before HTTP response and delayed authors:** recognition text is compared with server-prepared text only after acceptance, and missing author attribution waits. Another person's identical text still stops Victor.
- **Provider backoff:** the run remains busy, so the reply timer re-arms rather than resubmitting. Existing test advances an hour of retry wait and observes one POST and one synthesis.
- **Concurrent source reservations/queued Interrupt:** transaction ordering and write-once source records preserve the first source; replacement records are copied before interrupt task admission. Unused source reservations are intentional, not evidence of wrong admission.
- **Cross-account late restoration:** shared store locks person storage and reloads on identity change; it does not retarget an existing document's callbacks to the next person. No cross-account disclosure was established.
- **Detached cache handles:** tests explicitly establish that late writes cannot resurrect retired named caches. Best-effort cleanup and duplicate network misses are resource limits, not new correctness findings.

## Validation ledger

Initial reproduction: VSM-1 controller and isolated-browser regressions failed with the exact differences above; VSM-2 regressions failed for both failure modes. After both repairs, **347 tests passed, none failed or skipped**:

```sh
node --test --test-concurrency=2 test/victor-{mode,listening,worker,composer-adapter,assets,http,cache,reply-style,extension-config,registration}.test.ts test/{voice,service-worker,notify}.test.ts
node --test --test-concurrency=2 test/victor-composer-ui.test.ts test/victor-cache-ui.test.ts
```

The first command passed 318 tests; the second passed 29 isolated Chromium checks, including draft persistence across reload after error/pagehide and real service-worker cache persistence. Earlier focused red/green runs are subsets, not additional test counts.

Also passed: `npm run check`, `npm --prefix docs-site run check` (documentation pages, references and links), ESLint and Prettier on changed files, immediate `node --check` on both changed web modules, and `git diff --check`. No outstanding failures were observed. No dependencies, stored document schemas, or live data were changed; no application restart was performed. Issues remain local to this document; nothing was published.

Physical iPhone/Safari audio routing, actual recognition/synthesis quality, browser storage eviction under device pressure, and long-session reliability require separate qualification. The full upstream suite was not run for these focused changes; see [validation policy](../AGENTS.override.md#validation).
