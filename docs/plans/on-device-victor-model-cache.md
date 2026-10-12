# On-device Victor model cache

Status: implemented. Focused automated validation passed; the full suite also fails on unchanged HEAD (see Validation).

## Goal

Keep the existing Victor behavior and engine lifecycle, while ensuring the approximately 149 MB of immutable sherpa, Kroko and Kitten assets are downloaded once per bundle and then read from explicit browser Cache Storage.

The first Victor activation for a bundle still downloads and initializes everything. Later activations use local bytes, including after Victor is turned off, the worker is terminated, the page is closed, or the browser is restarted. A person who wants to avoid cellular transfer can enable Victor once on Wi-Fi using the same stable HTTPS origin they use later.

Do not keep the WASM worker alive, cache generated speech, add offline app behavior, add a model-management screen, or change recognition/synthesis models in this change.

## Evidence and expected benefit

A test-only service worker loaded the real production bundle twice on the target iPhone: once from unique network URLs into Cache Storage, then from that explicit cache.

| Measurement               |     Cold |                       Cached |
| ------------------------- | -------: | ---------------------------: |
| Complete initialization   | 11.140 s |                      3.281 s |
| Reported network transfer | 149.2 MB | none; Cache Storage response |
| Cache entries             |        — |                          366 |

The measured difference was **7.859 seconds, or 70.5% of cold startup**. Stable engine construction accounted for about 1.645 seconds of the cached run: STT 1.303 seconds and TTS 0.342 seconds. The remainder was local file reads, MEMFS mounting, wrapper work and WASM setup. Individual phase boundaries are coarse—one warm TTS-wrapper phase absorbed about a second of deferred work—so total initialization time is the qualification metric.

This result supports an explicit cache. It does not promise a fixed startup time on every device or establish how long iOS retains best-effort website data.

## 1. Cache only immutable Victor assets

File: `web/sw.js`.

Extend the existing service worker’s fetch handler for `GET /victor-assets/<bundle>/…` only. Keep `/victor-assets/manifest.json`, app files, API responses and uploads out of this cache.

- Name each cache `pocket-victor-<bundle>`, where `<bundle>` is the versioned path segment already pinned by `victor-assets.json`.
- On a hit, return the cached response without a network request.
- On a miss, fetch the request with the ordinary HTTP cache bypassed, return the network response, and store a clone with `event.waitUntil`. A Cache Storage write failure must not prevent Victor from using the network response.
- Restrict caching to same-origin, successful responses under the exact versioned Victor path. Preserve response headers and the server’s existing allowlist, sizes, ETags and immutable URLs.
- When a different bundle is first requested, remove only older `pocket-victor-` caches. Leave the share cache and every unrelated origin cache untouched.
- Partial downloads are valid. A stopped or failed first activation leaves completed entries in place; the next activation fetches only missing entries.

Do not pre-cache 149 MB during service-worker installation. Installation and app startup must remain small and reliable.

## 2. Register caching independently of notifications

Files: `web/notify.js`, minimal `web/victor-mode.js` changes.

The service worker currently registers only when push-notification APIs are present. Separate the two capability checks:

- Register `/sw.js` on secure origins whenever Service Workers are supported, whether or not notifications are supported or enabled.
- Keep notification controls conditional on `PushManager` and `Notification` exactly as they are now.
- Start registration when the app loads, as today. On the Victor tap, synchronously create/resume the AudioContext first, preserving iOS activation, then allow a short wait for the registering worker to take control before creating the speech worker. Registration failure or an unsupported service worker falls back to the existing network/HTTP-cache path rather than disabling Victor.
- From the Victor tap, request persistent origin storage with `navigator.storage.persist()` when available. Do not wait for or require approval; denial and API failure are silent best-effort fallbacks.

No new preference is needed. Cache Storage is scoped to the browser profile and origin. Local, Tailscale and Cloudflare addresses therefore have separate caches; a changing Cloudflare quick-tunnel hostname cannot reuse an earlier origin’s cache. Document that a stable Tailscale or named-tunnel address should be used on both Wi-Fi and cellular.

## 3. Keep model and worker behavior unchanged

Files: `web/victor-worker.js` only if readiness metadata is needed for tests or cache cleanup.

The speech worker continues to:

- construct ASR before importing TTS;
- use one shared WASM instance;
- mount the same verified files and pronunciation tree;
- fix Kitten speaker 2 and validate 24 kHz output;
- terminate on Victor off, hiding, navigation, lost ownership, timeout or fatal failure.

Cache Storage supplies responses to the existing URLs; it does not serialize a compiled WASM module or ONNX session. The approximately 3.3-second measured cached initialization floor remains expected.

Do not retain a warm worker by default. Its runtime starts with 512 MiB of WASM memory, which is a poor trade for an iPhone background or idle optimization.

## 4. Keep the first version deliberately small

Deferred unless later measurements justify them:

- a Download/Remove models screen;
- background prefetching or cellular-network detection;
- IndexedDB or OPFS storage;
- packing the 355 pronunciation files;
- caching synthesized replies;
- sharing caches across origins;
- a warm-worker timeout or SharedWorker;
- an offline app shell.

The first activation itself is the explicit download action. Existing preparation status remains sufficient; documentation tells people to perform it once on Wi-Fi if cellular transfer matters.

## 5. Validate failure and lifecycle behavior

Add focused service-worker tests using the project’s existing VM/browser patterns:

- a versioned Victor miss fetches once and stores a clone;
- the next identical request is answered from Cache Storage with no network call;
- manifest, API, app and non-Victor requests are untouched;
- a failed response is not cached;
- quota/write failure still returns the network response;
- a partial cache resumes by fetching only missing assets;
- a new bundle removes only older Victor caches;
- notification-unavailable browsers still register the worker for caching;
- service-worker registration, persistence denial and cache failure never block Victor;
- the AudioContext is still activated synchronously on the Victor tap;
- Victor teardown and stale-callback protections remain unchanged.

Run the existing focused Victor controller, worker, asset and dictation tests. Then run `node --check` on changed web files, `npm run format`, `npm run lint`, `npm run check` and `npm test`.

Add an automated Chromium integration test against an isolated throwaway app and data directory. Give its HTTP server a small test-only route under `/victor-assets/test-bundle/`; do not load the 149 MB production bundle in the test suite. The test must:

1. wait for `/sw.js` to install and control the page;
2. fetch a fixture asset and confirm the server receives the cold request;
3. reload the page, fetch the same URL, and confirm the bytes match while the server request count does not increase;
4. leave a partial bundle, retry it, and fetch only its missing fixture;
5. request a second bundle and confirm only older Victor caches are removed;
6. preserve the existing share cache and every unrelated cache;
7. run at the mobile viewport used by the other browser UI tests.

Keep engine behavior covered by the existing worker/controller tests and victor-asset manifest tests. Cache write failure, registration failure, persistence denial, interruption and stale callbacks use deterministic mocks rather than manual browser actions.

There is no manual acceptance step and no additional device test. The completed iPhone benchmark remains design evidence only; automated tests are the release gate.

## Documentation

Update `docs/features.md`, `docs/map.md` and `docs/architecture.md` to explain:

- Victor assets use explicit, versioned, origin-local Cache Storage;
- first activation downloads about 149 MB and later activations still reconstruct the engines;
- enabling once on Wi-Fi primes only that stable origin;
- iOS may evict best-effort website data, though persistent storage is requested;
- clearing website data removes the models.

## Done

The first activation downloads and stores the current Victor bundle without changing the conversation loop. Subsequent activations on the same origin read all model assets locally, avoid cellular model transfer, and remain around the measured engine-initialization floor. Cache failures degrade to today’s network behavior, old Victor bundles are removed, and no unrelated app resource is cached.

## Validation

Checked on 2026-10-12:

- All 140 focused tests passed: cache VM and Chromium integration, registration, controller, worker, assets and dictation. Chromium used small fixtures and a 390 × 844 viewport, not the production bundle.
- `node --check` passed for all changed web files. `npm run format`, `npm run lint` and `npm run check` passed. Documentation tests passed too. Formatting left unrelated local notes untouched.
- `npm test`: 573 passed, 11 failed out of 584. An isolated, unchanged `HEAD` copy had 526 passed and 10 failed out of 536. Nine failures matched between the runs; the two remaining current-tree failures (drop-in reload timeout and compaction timing) passed when rerun in isolation. The repository-wide gate remains blocked by these existing failures; it is not a green full-suite result.

No new device benchmark or manual acceptance step was used. The iPhone measurements above remain design evidence, not a new performance qualification.
