# Drop-in streaming speech models

## Scope

Compare the user's unchanged recording without changing the MVP architecture: the published `sherpa_onnx_web` 1.13.8 WASM and matching wrapper, one recognition worker, the existing AudioWorklet, continuous streaming input, the “send it” command, strict CSP, and native local TTS.

Only model assets and supported recognizer settings may change. **Moonshine and batch-only Whisper are excluded.** No new runtime, windowed transcription, cloud speech, hotword hints, transcript corrections, or model-picker UI is part of this work.

## Input and results

The requested phrase was:

> Hello there. Please say the word sunshine. Send it.

The original user attachment is mono AAC, 48 kHz, 6.485333 seconds. Its SHA-256 is `ea4979e2c5cacf992455e941ba09c1e9a40c60f9e74f3dba60e414131c7e66d4`. It remains untouched and is not committed. A separate, untrimmed 48 kHz PCM WAV was used for the comparison; SHA-256 `48fd354e23852d67f840014f19c7fce011255807680cc776332caf3e1e4b5890`.

All candidates below ran through the **same published WASM streaming transducer API**. The raw words, including the command, were:

| Model                       | Raw recognition, without added leading silence       | Selected model files | With runtime and JS |
| --------------------------- | ---------------------------------------------------- | -------------------: | ------------------: |
| Original 20M, 2023-02-17    | `ULAR PLEASE SAY THE WORD SUNSHINE SEND IT`          |             45.20 MB |            60.48 MB |
| Zipformer, 2023-06-26       | `HULLO THERE PLEASE SAY THE WORD SUNSHINE SEND IT`   |             73.44 MB |            88.72 MB |
| Zipformer, 2023-06-21       | `HELLO THERE PLEASE SAY THE WORD SUNSHINE SEND IT`   |            190.18 MB |           205.46 MB |
| Kroko Zipformer, 2025-08-06 | `Hello there Please say the word sunshine. Send it.` |             71.05 MB |            86.33 MB |

These are decimal file/download sizes, not RAM estimates. `HULLO` is the June 26 model's actual spelling; it has not been changed to `HELLO`.

For each larger/newer candidate, whole-recording input and 100 ms streaming batches returned the same words. Adding 0.5 seconds of leading silence also preserved the words. Kroko changed punctuation to `Hello there. Please say the word sunshine, send it` with that padding. All candidates produced the command in a partial result before finalization, so they work with the existing keyword mechanism.

The opening-word error follows the original model choice, not frontend text trimming. The original 20M bundle returned the same incorrect opening from the original M4A and decoded WAV, with different chunk sizes, preroll, greedy/beam decoding, and float/quantized weights. The replacement models recover the opening from the same audio without any phrase-specific hints.

**This is one short recording, not a general speech-accuracy benchmark.** It supports a model choice for this MVP, not a universal ranking.

## Memory and responsiveness

Measurements used one fresh Node process per candidate on the same Intel Mac, with the unchanged WASM runtime. Four utterances reused one recognizer, with a new stream for each. Model buffers were loaded into MEMFS and unlinked after recognizer creation, as in the browser worker.

| Model   | WASM linear memory throughout | Isolated process peak RSS |  Internal decode step |
| ------- | ----------------------------: | ------------------------: | --------------------: |
| June 26 |                       512 MiB |                   485 MiB | about 0.32 s of audio |
| June 21 |                       512 MiB |                   689 MiB | about 0.32 s of audio |
| Kroko   |                       512 MiB |                   485 MiB | about 1.28 s of audio |

Peak RSS includes Node/V8, compilation, model buffers, ONNX Runtime and temporary work. It is not Safari's memory usage. Linear memory is not the same as resident memory, and the iPhone's 6 GB RAM is not all available to one Safari tab. **Physical iPhone fit, sustained speed and tab survival remain unverified.**

The 6.49-second clip took roughly 1.1–1.3 seconds of compute with June 26, 1.5–1.7 seconds with June 21, and 0.66–0.74 seconds with Kroko in 100 ms input batches. These exclude network download and model initialization, include finalization, and were observed while other agents were active. They are not controlled performance rankings or phone timings.

Kroko's lower observed compute cost does not mean earlier partial text: its internal chunks are longer. Sending 100 ms batches cannot make a 1.28-second-chunk model revise the transcript every 100 ms. That tradeoff is compatible with this MVP's explicit command and tap-between-turns design; it would matter more for a future interruption-sensitive feature.

## Recommendation

**Kroko is now the default.** It passed the unchanged browser loop with the user’s recording, preserving all intended words, submitting once without the command, and producing actual local TTS start/end events. It recovered every intended word with a much smaller download and lower observed peak RSS than June 21. Its complete speech bundle adds about 25.9 MB over the original baseline.

June 21 remains the larger same-API alternative, with finer partial updates and exact words on this recording. June 26 also preserves the opening at a similar size to Kroko, using the spelling “hullo.” No alternate-model selector or fallback chain is proposed.

The authoritative browser acceptance result is in [validation notes](on-device-victor-mvp-validation.md).

## Provenance and reproducibility

All comparison runs used one CPU thread, `greedy_search`, endpoint submission disabled, 80-dimensional features at 16 kHz, and native conversion from the actual 48 kHz input. `modelType` and `modelingUnit` remained empty for metadata-based detection. Only the encoder, decoder, joiner and token file paths changed.

Upstream model catalogs, pinned to the revisions actually tested:

- [June 26](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/tree/672fbf1b30579d6585301139bb363f42a0ad4a24): int8 encoder/joiner, float decoder, tokens.
- [June 21](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-21/tree/9a65b6ea94c311ca770c2bf895b30f456a22d703): int8 encoder/joiner, float decoder, tokens.
- [Kroko](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06/tree/572aaf4e2e0c603c3fc2a574d096e755a178faa1): published `encoder.onnx`, `decoder.onnx`, `joiner.onnx`, and `tokens.txt`. Despite their names, the published ONNX files contain quantized operators and integer initializers.
- [Published runtime](https://pub.dev/packages/sherpa_onnx_web/versions/1.13.8), embedded revision `8b5a9990d2d787d6a7d4238b0d2e7777090bfd03`.

The repository's `victor-assets.json` records every file/hash for the selected production bundle. The disposable comparison harness, complete partial results, per-file hashes and metadata snapshots remain under `/tmp/pi-pocket-voice-mvp/larger-zipformer/`; the consolidated scratch report is `/tmp/pi-pocket-voice-mvp/larger-zipformer.md`. Those temporary paths are supporting diagnostics; the findings needed to understand the choice are retained in this document.
