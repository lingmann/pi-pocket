// The classic worker runs in an isolated global, with stand-ins for its pinned WASM wrappers.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../web/victor-worker.js", import.meta.url), "utf8");
const specification = JSON.parse(
    await readFile(new URL("../victor-sources.json", import.meta.url), "utf8"),
);
const pack = new Uint8Array([10, 20, 30, 40, 50, 60]);
const packAsset = {
    name: "tts/pronunciation.data",
    bytes: pack.length,
    sha256: createHash("sha256").update(pack).digest("hex"),
    contentType: "application/octet-stream",
};
const pinned = {
    schemaVersion: 2,
    bundle: `victor-${"a".repeat(64)}`,
    bundleBase: `/victor-assets/victor-${"a".repeat(64)}/`,
    runtime: specification.runtime,
    model: specification.model,
    tts: {
        ...specification.tts,
        pronunciation: {
            asset: packAsset.name,
            files: [
                { path: "en_dict", offset: 0, bytes: 2 },
                { path: "lang/gmw/en", offset: 2, bytes: 1 },
                { path: "voices/!v/voice name ", offset: 3, bytes: 3 },
            ],
        },
    },
    assets: [
        ...specification.assets.map((asset: { name: string }) => ({
            ...asset,
            bytes: 1,
            sha256: "b".repeat(64),
        })),
        packAsset,
    ],
};

type Message = {
    type: string;
    speechId?: number;
    message?: string;
    samples?: Float32Array;
    sampleRate?: number;
};
type Generation = { sid: number; speed: number; silenceScale: number };
type RuntimeOptions = { onAbort: (reason: string) => void; locateFile: (name: string) => string };

function worker(
    options: {
        holdTts?: boolean;
        sampleRate?: number;
        numSpeakers?: number;
        handle?: number;
        pack?: Uint8Array;
    } = {},
) {
    const manifest = structuredClone(pinned);
    const messages: Message[] = [];
    const imports: string[] = [];
    const fetched: string[] = [];
    const writes: string[] = [];
    let completion = Promise.withResolvers<Message>();
    const ttsRequested = Promise.withResolvers<void>();
    const order: string[] = [];
    const mounted = new Map<string, Uint8Array>();
    const constructions: { runtime: unknown; config: unknown }[] = [];
    const generations: { text: string; config: Generation }[] = [];
    const transfers: ArrayBuffer[][] = [];
    const streams: {
        handle: number;
        freed: boolean;
        batches: number;
        free: () => void;
        acceptWaveform: () => void;
        inputFinished: () => void;
    }[] = [];
    const ttsGate = Promise.withResolvers<void>();
    let cleanup = "";
    let runtimeOptions: RuntimeOptions;
    let createCount = 0;
    let output: { samples: unknown; sampleRate: unknown } | null = {
        samples: new Float32Array([0, 0.25, -0.5]),
        sampleRate: 24000,
    };
    let generate = () => output;
    const runtime = {
        FS: {
            mkdir() {},
            mkdirTree() {},
            writeFile(path: string, bytes: Uint8Array, options: { canOwn: boolean }) {
                assert.equal(options.canOwn, true);
                writes.push(path);
                mounted.set(path, bytes);
            },
            unlink(path: string) {
                mounted.delete(path);
            },
        },
    };
    const self = {
        location: { origin: "https://pocket.test" },
        onmessage: (_event: { data: unknown }) => {},
        postMessage(message: Message, transfer: ArrayBuffer[] = []) {
            messages.push(structuredClone(message, { transfer }));
            transfers.push(transfer);
            order.push(message.type);

            if (message.type === "ready" || message.type === "error") {
                completion.resolve(message);
            }
        },
        async SherpaOnnx(value: RuntimeOptions) {
            runtimeOptions = value;
            createCount++;
            order.push("runtime");
            assert.equal(
                value.locateFile("runtime.wasm"),
                `https://pocket.test${manifest.bundleBase}${manifest.runtime.wasm}`,
            );

            return runtime;
        },
        createOnlineRecognizer(module: unknown, config: unknown) {
            assert.equal(cleanup, "asr", "ASR must finish before TTS replaces freeConfig");
            constructions.push({ runtime: module, config: structuredClone(config) });
            order.push("asr");

            return {
                handle: 1,
                createStream() {
                    const stream = {
                        handle: 2,
                        freed: false,
                        batches: 0,
                        free() {
                            this.freed = true;
                        },
                        acceptWaveform() {
                            this.batches++;
                        },
                        inputFinished() {},
                    };

                    streams.push(stream);

                    return stream;
                },
                isReady: () => false,
                decode() {},
                getResult: () => ({ text: "kept draft" }),
            };
        },
        createOfflineTts(module: unknown, config: unknown) {
            assert.equal(cleanup, "tts");
            assert.equal(mounted.has("/victor/tokens.txt"), false);
            assert.ok(mounted.has("/tts/tokens.txt"));
            assert.ok(mounted.has("/tts/espeak-ng-data/en_dict"));
            constructions.push({ runtime: module, config: structuredClone(config) });
            order.push("tts");

            return {
                handle: options.handle ?? 3,
                numSpeakers: options.numSpeakers ?? 8,
                sampleRate: options.sampleRate ?? 24000,
                generateWithConfig(text: string, config: Generation) {
                    generations.push({ text, config: structuredClone(config) });

                    return generate();
                },
            };
        },
    };

    runInNewContext(source, {
        self,
        URL,
        Float32Array,
        Uint8Array,
        Error,
        WebAssembly,
        crypto: webcrypto,
        async fetch(url: string) {
            fetched.push(url);

            if (url === "/victor-assets/manifest.json") {
                return { ok: true, json: async () => manifest };
            }

            assert.ok(url.startsWith(`https://pocket.test${manifest.bundleBase}`));

            if (options.holdTts && url.includes("/tts/")) {
                ttsRequested.resolve();
                await ttsGate.promise;
            }

            return {
                ok: true,
                arrayBuffer: async () =>
                    url.endsWith("/pronunciation.data")
                        ? new Uint8Array(options.pack ?? pack).buffer
                        : new ArrayBuffer(1),
            };
        },
        importScripts(...urls: string[]) {
            for (const url of urls) {
                imports.push(url);

                if (url.endsWith("-asr.js")) {
                    cleanup = "asr";
                } else if (url.endsWith("-tts.js")) {
                    cleanup = "tts";
                    order.push("import-tts");
                }
            }
        },
    });

    const send = (data: unknown) => self.onmessage({ data });

    return {
        messages,
        imports,
        fetched,
        writes,
        blocked: () => ttsRequested.promise,
        order,
        mounted,
        constructions,
        generations,
        streams,
        transfers,
        manifest,
        send,
        async init() {
            if (messages.at(-1)?.type === "error") {
                send({ type: "init" });

                return;
            }

            completion = Promise.withResolvers<Message>();
            send({ type: "init" });
            await completion.promise;
        },
        releaseTts: () => ttsGate.resolve(),
        abort: () => runtimeOptions.onAbort("test abort"),
        createCount: () => createCount,
        output(value: typeof output) {
            output = value;
        },
        generate(value: typeof generate) {
            generate = value;
        },
        speak(speed?: unknown, speechId = 7) {
            send({ type: "synthesize", speechId, text: "A complete reply.", speed, sid: 0 });

            return messages.at(-1)!;
        },
    };
}

test("victor worker creates ASR before importing TTS, shares one runtime, and waits for both", async () => {
    const w = worker({ holdTts: true });

    const initialization = w.init();

    await w.blocked();
    assert.deepEqual(w.order, ["runtime", "asr", "import-tts"]);
    assert.equal(w.messages.length, 0);
    w.releaseTts();
    await initialization;
    assert.deepEqual(w.order, ["runtime", "asr", "import-tts", "tts", "ready"]);
    assert.equal(w.constructions[0]!.runtime, w.constructions[1]!.runtime);
    assert.equal(w.createCount(), 1);
    assert.deepEqual(w.constructions[1]!.config, {
        offlineTtsModelConfig: {
            offlineTtsKittenModelConfig: {
                model: "/tts/model.onnx",
                voices: "/tts/voices.bin",
                tokens: "/tts/tokens.txt",
                dataDir: "/tts/espeak-ng-data",
                lengthScale: 1,
            },
            numThreads: 1,
            provider: "cpu",
            debug: 0,
        },
        maxNumSentences: 1,
    });
    assert.equal(w.mounted.size, 3 + pinned.tts.pronunciation.files.length);
    await w.init();
    assert.equal(w.createCount(), 1);
    assert.equal(w.constructions.length, 2);
    assert.equal(w.imports.length, 3, "each wrapper imports once");
});

test("victor worker fixes speaker 2, validates speed, and transfers standalone 24 kHz PCM", async () => {
    const w = worker();
    const heap = new Float32Array([9, 0.25, -0.5, 9]);

    await w.init();
    w.output({ samples: heap.subarray(1, 3), sampleRate: 24000 });

    for (const [speed, expected] of [
        [0.75, 0.75],
        [1, 1],
        [1.25, 1.25],
        [1.5, 1.5],
        ["1", 1],
        ["0.75", 0.75],
        [undefined, 1.25],
        [null, 1.25],
        [true, 1.25],
        [false, 1.25],
        [NaN, 1.25],
        [Infinity, 1.25],
        [2, 1.25],
        ["bogus", 1.25],
        ["", 1.25],
        [{}, 1.25],
    ]) {
        const result = w.speak(speed);

        assert.equal(result.type, "synthesized");
        assert.equal(result.speechId, 7);
        assert.equal(result.sampleRate, 24000);
        assert.deepEqual([...result.samples!], [0.25, -0.5]);
        assert.equal(result.samples!.byteOffset, 0);
        assert.equal(result.samples!.buffer.byteLength, 8);
        assert.equal(w.transfers.at(-1)!.length, 1);
        assert.equal(w.transfers.at(-1)![0]!.byteLength, 0, "output is transferred");
        assert.equal(heap.byteLength, 16, "the upstream heap is never transferred");
        assert.deepEqual(w.generations.at(-1)!.config, {
            sid: 2,
            speed: expected,
            silenceScale: 1,
        });
    }
});

test("victor worker completes unpunctuated speech without changing reply text", async () => {
    const w = worker();

    await w.init();

    for (const [text, expected] of new Map([
        ["Okay", "Okay."],
        ["  okay\n", "okay."],
        ["I can do that", "I can do that."],
        ["Okay.", "Okay."],
        ["Really?", "Really?"],
        ["Yes!", "Yes!"],
        ["Wait…", "Wait…"],
        ["He said “okay.”", "He said “okay.”"],
        ['He said "okay!"', 'He said "okay!"'],
        ["(Okay.)", "(Okay.)"],
    ])) {
        const request = { type: "synthesize", speechId: 1, text, speed: 1.25 };

        w.send(request);
        assert.equal(w.messages.at(-1)!.type, "synthesized");
        assert.equal(w.generations.at(-1)!.text, expected);
        assert.equal(request.text, text, "only synthesis input is normalized");
    }
});

test("victor worker rejects bad output and ordinary generation errors without discarding ASR", async () => {
    const w = worker();

    await w.init();
    w.send({ type: "start", turn: 3, sampleRate: 48000 });

    for (const output of [
        null,
        { samples: [], sampleRate: 24000 },
        { samples: new Float32Array(), sampleRate: 24000 },
        { samples: new Float32Array([0, -0]), sampleRate: 24000 },
        { samples: new Float32Array([NaN, 1]), sampleRate: 24000 },
        { samples: new Float32Array([Infinity, 1]), sampleRate: 24000 },
        { samples: new Float32Array([1]), sampleRate: 16000 },
    ]) {
        w.output(output);
        assert.equal(w.speak().type, "synthesis-error");
        assert.equal(w.messages.at(-1)!.speechId, 7);
    }

    w.generate(() => {
        throw new Error("utterance failed");
    });
    assert.equal(w.speak().type, "synthesis-error");
    assert.equal(w.streams[0]!.freed, false);
    assert.ok(w.mounted.has("/tts/espeak-ng-data/en_dict"));
    w.send({ type: "audio", turn: 3, samples: new Float32Array([0.25]) });
    assert.equal(w.streams[0]!.batches, 1);
    assert.equal(w.messages.at(-2)!.type, "partial");
    assert.equal(w.messages.at(-1)!.type, "ack");
    w.generate(() => ({ samples: new Float32Array([0.25]), sampleRate: 24000 }));
    assert.equal(w.speak(1.5, 8).type, "synthesized");
    w.send({ type: "finish", turn: 3 });
    assert.equal(w.messages.at(-1)!.type, "final");
    assert.equal(w.streams[0]!.freed, true);
    assert.equal(w.constructions.length, 2);
});

test("victor worker requires a TTS handle, speaker 2, and 24 kHz before ready; no in-worker retry", async () => {
    for (const options of [
        { handle: 0 },
        { numSpeakers: 2 },
        { numSpeakers: NaN },
        { sampleRate: 16000 },
    ]) {
        const w = worker(options);

        await w.init();
        assert.deepEqual(
            w.messages.map((m) => m.type),
            ["error"],
        );
        await w.init();
        assert.equal(w.createCount(), 1);
        assert.equal(w.constructions.length, 2);
        assert.equal(w.messages.length, 1);
    }
});

test("victor worker treats WASM traps and aborts as fatal, never recoverable synthesis failures", async () => {
    for (const mode of ["trap", "abort", "abort-then-throw"]) {
        const w = worker();

        await w.init();
        w.generate(() => {
            if (mode === "trap") {
                throw new WebAssembly.RuntimeError("unreachable");
            }

            w.abort();

            if (mode === "abort-then-throw") {
                throw new Error("aborted");
            }

            return { samples: new Float32Array([0.25]), sampleRate: 24000 };
        });
        assert.equal(w.speak().type, "error");
        assert.deepEqual(
            w.messages.map((m) => m.type),
            ["ready", "error"],
        );
        w.speak();
        w.send({ type: "start", turn: 4, sampleRate: 48000 });
        assert.equal(w.generations.length, 1);
        assert.equal(w.streams.length, 0);
        assert.equal(w.messages.length, 2);
    }
});

test("victor worker rejects foreign asset origins and TTS filesystem traversal", async () => {
    for (const name of [
        "tts/../tokens.txt",
        "tts//tokens.txt",
        "tts/model.onnx?other",
        "tokens.txt",
    ]) {
        const w = worker();

        w.manifest.tts.model = name;
        await w.init();
        assert.equal(w.messages.at(-1)!.type, "error");
        assert.match(w.messages.at(-1)!.message!, /invalid|not supported/);
    }

    const w = worker();

    w.manifest.runtime.ttsWrapper = "https://elsewhere.test/victor-assets/tts.js";
    await w.init();
    assert.equal(w.imports.length, 0);
    assert.match(w.messages.at(-1)!.message!, /invalid/);
});

test("victor worker mounts one verified pack as shared byte views", async () => {
    const w = worker();

    w.manifest.tts.pronunciation.files[2].path = "voices/!v/voice ?# ";
    await w.init();
    assert.equal(w.messages.at(-1)!.type, "ready");
    assert.equal(w.fetched.filter((url) => url.endsWith("/pronunciation.data")).length, 1);
    assert.equal(
        w.fetched.length,
        9,
        "manifest, four ASR, three TTS, one pack; scripts use importScripts",
    );
    const views = w.manifest.tts.pronunciation.files.map(
        (entry: { path: string; offset: number; bytes: number }) => {
            const view = w.mounted.get("/tts/espeak-ng-data/" + entry.path)!;

            assert.deepEqual(
                [...view],
                [...pack.subarray(entry.offset, entry.offset + entry.bytes)],
            );
            assert.equal(view.byteOffset, entry.offset);

            return view;
        },
    );

    assert.ok(views.every((view: Uint8Array) => view.buffer === views[0].buffer));
    assert.equal(views[0].buffer.byteLength, pack.length);
    assert.ok(!w.mounted.has("/tts/pronunciation.data"));
});

test("victor worker rejects the entire invalid index before any pronunciation writes", async () => {
    const cases: [string, (manifest: typeof pinned) => void][] = [];

    for (const path of [
        "/absolute",
        "../escape",
        "a/../../escape",
        "a//b",
        "a/./b",
        "a/../b",
        "a/",
        "",
        "a\\b",
        "a\0b",
    ]) {
        cases.push([
            "path " + JSON.stringify(path),
            (m) => {
                m.tts.pronunciation.files[2].path = path;
            },
        ]);
    }

    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        cases.push([
            "offset " + value,
            (m) => {
                m.tts.pronunciation.files[2].offset = value;
            },
        ]);
        cases.push([
            "length " + value,
            (m) => {
                m.tts.pronunciation.files[2].bytes = value;
            },
        ]);
    }

    cases.push(
        [
            "gap",
            (m) => {
                m.tts.pronunciation.files[2].offset = 4;
            },
        ],
        [
            "overlap",
            (m) => {
                m.tts.pronunciation.files[2].offset = 2;
            },
        ],
        [
            "truncated coverage",
            (m) => {
                m.tts.pronunciation.files[2].bytes = 2;
            },
        ],
        [
            "past end",
            (m) => {
                m.tts.pronunciation.files[2].bytes = 4;
            },
        ],
        [
            "duplicate",
            (m) => {
                m.tts.pronunciation.files[2].path = "en_dict";
            },
        ],
        [
            "file ancestor",
            (m) => {
                m.tts.pronunciation.files[2].path = "en_dict/child";
            },
        ],
        [
            "file descendant",
            (m) => {
                m.tts.pronunciation.files[2].path = "lang";
            },
        ],
        [
            "direct ancestor",
            (m) => {
                m.tts.dataDir = "tts/model.onnx/data";
            },
        ],
        [
            "directory is direct file",
            (m) => {
                m.tts.dataDir = "tts/model.onnx";
            },
        ],
        [
            "direct collision",
            (m) => {
                const model = m.assets.find((asset) => asset.name === m.tts.model)!;

                model.name = m.tts.model = `${m.tts.dataDir}/en_dict`;
            },
        ],
        [
            "empty index",
            (m) => {
                m.tts.pronunciation.files = [];
            },
        ],
        [
            "unsafe directory",
            (m) => {
                m.tts.dataDir = "tts/../data";
            },
        ],
        [
            "outside tts",
            (m) => {
                m.tts.dataDir = "other/data";
            },
        ],
    );

    for (const [label, mutate] of cases) {
        const w = worker();

        mutate(w.manifest);
        await w.init();
        assert.equal(w.messages.at(-1)!.type, "error", label);
        assert.equal(w.writes.length, 0, label);
        assert.equal(w.imports.length, 0, label);
    }
});

test("victor worker rejects truncated or corrupt pack bytes before mounting", async () => {
    for (const bytes of [pack.subarray(0, 5), new Uint8Array(7), new Uint8Array(6)]) {
        const w = worker({ pack: bytes });

        await w.init();
        assert.equal(w.messages.at(-1)!.type, "error");
        assert.match(w.messages.at(-1)!.message!, /length|checksum/);
        assert.equal(w.constructions.length, 1);
        assert.equal(w.writes.filter((path) => path.startsWith("/tts/espeak-ng-data/")).length, 0);
        assert.equal(w.fetched.filter((url) => url.endsWith("/pronunciation.data")).length, 1);
    }
});

test("victor worker rejects unsupported or incomplete schema-2 manifests before imports", async () => {
    const mutations: ((m: typeof pinned) => void)[] = [
        (m) => {
            m.schemaVersion = 1;
        },
        (m) => {
            m.schemaVersion = 3;
        },
        (m) => {
            m.bundle = "victor-old";
        },
        (m) => {
            m.bundleBase += "other/";
        },
        (m) => {
            m.model.type = "other";
        },
        (m) => {
            m.model.sampleRate = 0;
        },
        (m) => {
            m.model.featureDim = 0;
        },
        (m) => {
            m.assets.pop();
        },
        (m) => {
            m.assets[0] = m.assets[1];
        },
        (m) => {
            m.model.encoder = "unlisted.onnx";
        },
        (m) => {
            m.runtime.script = "unlisted.js";
        },
        (m) => {
            m.tts.tokens = m.tts.model;
        },
        (m) => {
            m.assets.at(-1).sha256 = "not-a-hash";
        },
        (m) => {
            m.assets.at(-1).bytes = -1;
        },
    ];

    for (const mutate of mutations) {
        const w = worker();

        mutate(w.manifest);
        await w.init();
        assert.equal(w.messages.at(-1)!.type, "error");
        assert.equal(w.imports.length, 0);
        assert.equal(w.writes.length, 0);
    }
});

test("victor worker accepts supported updated configs and encoded public filenames", async () => {
    const w = worker();
    const old = w.manifest.tts.model;
    const name = "tts/model ! updated.onnx ";

    w.manifest.assets.find((asset: { name: string }) => asset.name === old).name = name;
    w.manifest.tts.model = name;
    w.manifest.model.sampleRate = 22050;
    w.manifest.model.featureDim = 40;
    await w.init();
    assert.equal(w.messages.at(-1)!.type, "ready");
    assert.ok(w.fetched.some((url) => url.endsWith("/tts/model%20!%20updated.onnx%20")));
    assert.ok(w.mounted.has("/" + name));
});
