# Victor pronunciation data pack and model updates

Status: source specification, full-build preparation, deterministic packing, schema-2 HTTP serving, worker mounting, and cache regression tests are implemented. Isolated Chromium real-engine acceptance passed: two turns and replay, cold 12 assets plus manifest, warm zero asset downloads, and real MEMFS shared-buffer ownership. See the [operator guide](../victor.md) for current setup and use. Production preparation/restart and physical-iPhone qualification remain operator actions; neither was performed. This is a clean break: existing prepared assets, downloaded archives, and old manifest formats have no compatibility or migration support.

## Decision

Use one checked-in source specification and one preparation command. Preparation validates an unchanged installed bundle and becomes a no-op only when its receipt, inputs, manifest, and every blob match. Otherwise it downloads pinned upstream archives, builds the complete bundle, and generates its serving manifest. This supersedes the original decision to rebuild on every invocation without a fast path. Do not check the generated manifest into Git or maintain a separate manifest-refresh workflow.

Deliver the pronunciation tree as one immutable `tts/pronunciation.data` file, with a path/offset index in the generated manifest. Mount its contents into the existing Emscripten filesystem before constructing Kitten TTS. Keep large models, the voice bank, WASM, and JavaScript separate.

This follows the conventional [Emscripten preload pattern](https://emscripten.org/docs/porting/files/packaging_files.html): a data file plus metadata that recreates files in the virtual filesystem. Use the existing `runtime.FS` API; do not add an Emscripten SDK, rebuild sherpa, or introduce a browser archive library. The small Victor loader follows that pattern, not Emscripten's generated-loader format.

For the current models, this replaces **366 asset downloads with 12**, plus the manifest request. The 355 pronunciation files total approximately 18 MB; total uncompressed asset bytes remain approximately 149 MB. This reduces request overhead, not model weight.

## 1. Source specification and generated output

### Checked in: `victor-sources.json`

This is the sole asset-build input, alongside the preparation script. It contains:

- Exact URLs and reviewed SHA-256 pins for the runtime, ASR, and TTS archives.
- Exact archive members for the 11 separate assets and the pronunciation subtree prefix.
- The current runtime, ASR, and TTS configuration.

Replace the existing checked-in `victor-assets.json` with this smaller source specification. No generated lockfile, individual pronunciation-file pins, or duplicated reconstruction recipe is needed: archive hashes pin the inputs, and version-controlled builder code defines the transformation.

The builder supports the current sherpa runtime, streaming transducer ASR, and Kitten layout only. A model requiring another engine API still needs a deliberate code change.

### Generated and ignored: `vendor/victor/`

```text
vendor/victor/
    manifest.json          # Currently prepared bundle's serving manifest
    .prepared.json         # Local receipt binding inputs to the exact manifest
    victor-<sha256>/
        <asset-sha256>     # 12 hash-named blobs for the current models
```

The generated manifest contains the runtime/model configuration, the 12 downloadable asset names/sizes/hashes/content types, and the pronunciation index. Record source archive URLs and hashes for provenance, but do not include a recipe for reconstructing assets from this output: preparation always reads `victor-sources.json`.

Use one new manifest schema and reject unsupported schemas. Keep the existing public endpoint `/victor-assets/manifest.json`; only its on-disk source changes. No old-format reader or asset migration.

## 2. One preparation command

```sh
node scripts/victor/prepare-victor-assets.mjs
```

Every invocation follows the same decision:

1. Read and validate `victor-sources.json`, even when output already exists.
2. Check the ignored `vendor/victor/.prepared.json` receipt. It binds SHA-256 hashes of the raw source specification and builder text to the exact generated manifest. If the inputs and installed manifest match, verify every installed blob is a regular file with its recorded length and SHA-256. Only if all checks pass, finish without network requests or writes.
3. Otherwise download all three archives into a temporary staging directory and verify their pinned hashes before extraction.
4. Extract the selected direct assets and pronunciation tree, then build the data pack and manifest payload.
5. Compute asset sizes/hashes and the bundle ID. Validate the complete result before installation.
6. Install the blobs under `vendor/victor/<bundle>/`. If that directory already exists, replace its hash-named blobs with the rebuilt files using atomic file renames; do not delete the directory first.
7. Write the receipt, then atomically replace `vendor/victor/manifest.json` **last**, so it never points to an incomplete new bundle. Remove staging files and downloaded archives afterward.

A missing or invalid receipt, changed input or manifest, or missing/corrupt blob takes the full-build path. Output prepared before receipts existed rebuilds once. Delete `.prepared.json` to force a full rebuild; use the same command, with no new flags. Do not add local-archive flags, `--refresh-manifest`, an archive cache, incremental repair, or automatic update detection. Failures before manifest replacement leave the previous manifest and valid installed files intact; an unused output directory after failure is harmless. A receipt published before an interrupted manifest replacement cannot authorize a no-op against a different manifest.

The no-op still reads and hashes about 149 MB of local blobs, but avoids about 106 MB of archive downloads and all output writes. Any full build still downloads all three archives, even when only one model changed. The `just start` and `just start-local` recipes run preparation once as a prerequisite and stop if it fails. Direct server startup, in-app restarts, and browser activation do not run preparation. The receipt is not runtime metadata and changes neither browser caching nor restart requirements.

Archive validation remains necessary regardless of compatibility: reject unsafe destinations, duplicate selected entries, links, and link ancestors before extraction. Restrict extraction to validated members. Use the existing system `tar` dependency rather than building a general archive subsystem.

## 3. Data pack and versioning

Concatenate the pronunciation files without compression, headers, padding, or timestamps. Preserve the entire upstream pronunciation tree; do not prune languages. Sort paths in a fixed, locale-independent lexical order and record each file's relative path, byte offset, and length.

Illustrative metadata; these are not production offsets:

```json
{
    "tts": {
        "dataDir": "tts/espeak-ng-data",
        "pronunciation": {
            "asset": "tts/pronunciation.data",
            "files": [
                { "path": "en_dict", "offset": 0, "bytes": 100 },
                { "path": "lang/gmw/en", "offset": 100, "bytes": 20 }
            ]
        }
    }
}
```

The pack is one `application/octet-stream` asset. Index entries are virtual filesystem files, **not** HTTP assets. One pack hash covers all packed bytes; per-entry hashes are unnecessary.

Construct the manifest payload in a fixed field order, with deterministically ordered asset/index arrays. Derive `bundle` as `victor-<sha256>` from `JSON.stringify(payload)`, before adding the derived `bundle` and `bundleBase` fields. No generic canonical-JSON framework or manually bumped version is needed. The same source specification and builder must produce byte-identical output on supported hosts.

Changes to bytes, index, configuration, schema, or recorded source pins produce a new bundle URL. Preserve the existing whole-bundle cache policy: changing one model may cause all 12 assets to download again. No cross-version deduplication.

## 4. Worker and HTTP changes

Keep the worker classic and preserve its initialization ordering:

1. Fetch and validate the new manifest.
2. Load the shared runtime and ASR wrapper, mount ASR files, and construct ASR.
3. Only then import the TTS wrapper; its globals must not interfere with ASR construction.
4. Fetch and mount the three direct Kitten files explicitly, rather than looping over all assets tagged as TTS.
5. Fetch the pronunciation pack once. Verify its length and SHA-256 against the manifest using Web Crypto.
6. Validate the entire index before mounting: safe unique relative paths, safe integer offsets/lengths, contiguous ranges covering the pack exactly, and no file/directory or direct-asset collisions. Validate `tts.dataDir` below `/tts/`. Preserve legitimate spaces and `!v`; reject absolute/traversing paths and backslashes.
7. Create parent directories and mount byte views with `FS.writeFile(path, pack.subarray(...), { canOwn: true })`.
8. Construct TTS and retain the current handle, speaker-count, and 24 kHz checks. Report ready only after both engines work.

The pinned MEMFS implementation adopts external byte views without copying. Files share the pack's backing buffer and remain mounted until worker teardown for later synthesis. Recheck that ownership behavior when updating the runtime.

The HTTP handler reads `vendor/victor/manifest.json` instead of the repository-root manifest. Keep its allowlist, streamed responses, same-origin policies, immutable versioned URLs, and ETags. Do not unpack on the server, serve old pronunciation URLs, or add a route. Missing preparation remains a Victor-specific error, not an app-startup failure.

Keep `web/victor-cache.js` unchanged. It caches the pack as one response and already removes older Victor caches when a new bundle is requested. An interrupted uncached download retries the whole pack on the next activation. A completed but corrupt response can remain cached before the worker detects its checksum failure; document repairing server assets and clearing the affected Victor cache manually. No automatic eviction/retry machinery or cache-management UI.

## 5. Updating models and rollout

1. In an isolated checkout, edit the relevant source URL, reviewed archive hash, member paths, and supported configuration in `victor-sources.json`.
2. Run the preparation command. Review the source diff and generated size/hash summary; run the acceptance checks below.
3. Adopt the reviewed source/code changes in the serving checkout and run preparation there.
4. Ask the owner to restart the server, then reload clients before activating Victor. The server continues to retain a successfully loaded manifest until restart.

Update the sherpa runtime and matching wrappers together. A Kitten update must support the existing speaker 2 and 24 kHz output unless those assumptions are deliberately changed in code and tests. Archive integrity does not establish model accuracy or API compatibility; real-engine validation remains necessary.

Old archives, prepared directories, and cached assets are disposable. Do not translate them, reuse them through compatibility code, serve multiple generations, or promise seamless updates during initialization. Existing inactive directories may be removed manually; no cleanup command or automatic deletion is needed. Reverting an update means reverting source/code and preparing again, not relying on retained assets.

## 6. Isolation and essential tests

Implementation stays in Victor-owned files:

- Add `victor-sources.json`; remove the checked-in `victor-assets.json`.
- Update `scripts/victor/prepare-victor-assets.mjs`, `web/victor-worker.js`, and `src/server/http/victor-assets.ts`.
- Adapt `test/victor-*.test.ts` and document the workflow in `docs/victor.md`.

No new changes to Composer, app startup, shared HTTP routing, service-worker registration, `web/sw.js`, package dependencies, shared build tooling, CSP, or application data. Keep pack-building and mounting routines in their existing owners rather than creating a generic asset framework.

Use tiny archive/pack fixtures for automated checks:

- Identical inputs produce identical output; changed model bytes or configuration produce a new bundle ID. Archive entry order/timestamps do not affect pack bytes, though changed archive pins affect bundle identity.
- Bad source hashes and unsafe archive members fail before publication. Interrupted preparation leaves the current manifest usable; a rerun rebuilds missing/corrupt output.
- A matching receipt, raw inputs, exact manifest, and verified regular-file blobs permit a no-op with no network requests or writes. Invalid source specifications still fail before this check. Changed source or builder text, missing/invalid receipts, manifest changes, and missing, non-regular, truncated, or corrupt blobs must not take the no-op path. Receipt publication must precede manifest publication.
- Changing either the ASR or TTS source produces a coherent new bundle. Unchanged component bytes retain their hashes.
- Invalid paths, collisions, ranges, truncation, or checksums fail initialization. A valid pack mounts byte-correct files and causes exactly one pronunciation fetch.
- The HTTP handler serves only manifest-listed assets from generated output; missing output does not prevent ordinary app startup.
- A tiny pack survives worker/page reload through Cache Storage; interrupted downloads and new-bundle replacement retain existing cache behavior.

Worker fixtures should supply real Web Crypto and wait for explicit ready/error messages. Stand-in filesystem tests do not prove MEMFS ownership; verify that against the pinned runtime.

Finally, prepare the current real models on the isolated app from [self-editing](../self-editing.md). Check two recognition/reply/speech turns, replay, automatic listening, teardown, and non-silent 24 kHz audio. Record a cold trace with 12 asset URLs plus the manifest and a warm activation with no asset network downloads. Record initialization time and check for an unnecessary retained duplicate pack buffer. Report a missing physical-iPhone check explicitly.

During implementation, run `node --check` on edited web scripts, repository formatting, `npm run lint`, `npm run check`, and `npm test`. No live-data tests, automatic restart, commit, or deployment.

## What the clean break removes—and what it does not

Remove archive-reuse flags, incremental installed-output repair, a committed generated manifest, the refresh mode, reconstruction from generated metadata, migration, and rollback assumptions about retained assets. The receipt-verified no-op is the sole installed-output reuse path; it supersedes the original removal of all such reuse. The earlier plan already rejected old schemas; these are additional workflow simplifications, not compatibility layers that previously existed.

Keep deterministic output, source pins, safe extraction, index validation, immutable URLs, manifest-last publication, and model acceptance tests. Those protect correctness of the new system; they are not backward compatibility.

Still out of scope: compression, pronunciation pruning, runtime rebuilds, model/voice UI, automatic updates, delta/range downloads, cross-version deduplication, parallel-download scheduling, and offline-app support.
