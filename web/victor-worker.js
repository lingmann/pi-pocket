// Classic worker: the pinned Emscripten runtime and matching speech wrappers use importScripts.
// ASR and TTS share one WASM instance for each Victor activation; teardown terminates it.
// Wait for "ready" before "start", then for "started" before forwarding transferred PCM.
// An "ack" is sent after decoding each audio batch; relay it to the capture worklet.
let initialization = null;
let recognizer = null;
let tts = null;
let active = null;
let fatal = false;
const TTS_SPEAKER = 2; // Kitten Micro v0.8: expr-voice-3-m.
const TTS_SAMPLE_RATE = 24000;

function assetURL(value, base = self.location.origin) {
    if (typeof value !== "string" || !value) {
        throw new Error("The victor asset manifest is incomplete. Prepare the assets and retry.");
    }

    const url = new URL(
        base === self.location.origin ? value : value.split("/").map(encodeURIComponent).join("/"),
        base,
    );

    if (url.origin !== self.location.origin || !url.pathname.startsWith("/victor-assets/")) {
        throw new Error("Victor assets must come from this Pi Pocket server.");
    }

    return url.href;
}

async function fetchAsset(url) {
    const response = await fetch(url, { credentials: "same-origin" });

    if (!response.ok) {
        throw new Error(
            `Could not load victor assets (${response.status}). Prepare them and retry.`,
        );
    }

    return response;
}

async function initialize() {
    const response = await fetchAsset("/victor-assets/manifest.json");
    const manifest = await response.json();

    if (manifest.schemaVersion !== 2) {
        throw new Error(
            "This victor asset manifest is not supported. Prepare the assets and retry.",
        );
    }

    const base = assetURL(manifest.bundleBase);
    const runtimeURL = assetURL(manifest.runtime.script, base);
    const wrapperURL = assetURL(manifest.runtime.wrapper, base);
    const wasmURL = assetURL(manifest.runtime.wasm, base);
    const ttsWrapperURL = assetURL(manifest.runtime.ttsWrapper, base);

    if (manifest.tts?.type !== "kitten" || manifest.tts.sampleRate !== TTS_SAMPLE_RATE) {
        throw new Error("The local speech synthesis manifest is not supported.");
    }

    validateAssets(manifest);

    const pronunciation = validatePronunciation(manifest);

    importScripts(runtimeURL, wrapperURL);

    const runtime = await self.SherpaOnnx({
        onAbort: (reason) => reportError(new Error(`The local speech runtime aborted: ${reason}`)),
        locateFile: (name) => {
            if (!name.endsWith(".wasm")) {
                throw new Error(`Unexpected victor runtime asset: ${name}`);
            }

            return wasmURL;
        },
    });
    const files = {};

    runtime.FS.mkdir("/victor");

    try {
        // Load sequentially, letting MEMFS own each downloaded buffer rather than copying it.
        for (const name of ["encoder", "decoder", "joiner", "tokens"]) {
            const modelResponse = await fetchAsset(assetURL(manifest.model[name], base));
            const bytes = new Uint8Array(await modelResponse.arrayBuffer());
            const path = `/victor/${name}.${name === "tokens" ? "txt" : "onnx"}`;

            runtime.FS.writeFile(path, bytes, { canOwn: true });
            files[name] = path;
        }

        recognizer = self.createOnlineRecognizer(runtime, {
            featConfig: {
                sampleRate: manifest.model.sampleRate,
                featureDim: manifest.model.featureDim,
            },
            modelConfig: {
                transducer: {
                    encoder: files.encoder,
                    decoder: files.decoder,
                    joiner: files.joiner,
                },
                tokens: files.tokens,
                numThreads: 1,
                provider: "cpu",
                debug: 0,
                modelType: "",
                modelingUnit: "",
            },
            decodingMethod: "greedy_search",
            enableEndpoint: 0,
        });

        if (!recognizer.handle) {
            recognizer = null;

            throw new Error("The local speech recognizer could not load its model.");
        }
    } finally {
        // Model weights and tokens have been read into the recognizer; streams do not reopen them.
        for (const path of Object.values(files)) {
            runtime.FS.unlink(path);
        }
    }

    // Both wrappers define global freeConfig. ASR construction must finish before TTS replaces it.
    importScripts(ttsWrapperURL);

    for (const name of [manifest.tts.model, manifest.tts.voices, manifest.tts.tokens]) {
        const path = ttsPath(name);
        const modelResponse = await fetchAsset(assetURL(name, base));
        const bytes = new Uint8Array(await modelResponse.arrayBuffer());

        runtime.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
        runtime.FS.writeFile(path, bytes, { canOwn: true });
    }

    const packResponse = await fetchAsset(assetURL(pronunciation.asset.name, base));
    const pack = new Uint8Array(await packResponse.arrayBuffer());

    if (pack.byteLength !== pronunciation.asset.bytes) {
        throw new Error("The pronunciation pack has an incorrect length.");
    }

    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", pack));
    const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");

    if (hex !== pronunciation.asset.sha256) {
        throw new Error("The pronunciation pack checksum does not match.");
    }

    // Pinned MEMFS adopts these views: pronunciation files share one backing buffer.
    for (const { path, offset, bytes } of pronunciation.files) {
        runtime.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
        runtime.FS.writeFile(path, pack.subarray(offset, offset + bytes), { canOwn: true });
    }

    const kitten = {
        model: ttsPath(manifest.tts.model),
        voices: ttsPath(manifest.tts.voices),
        tokens: ttsPath(manifest.tts.tokens),
        dataDir: ttsPath(manifest.tts.dataDir),
        lengthScale: 1.0,
    };

    tts = self.createOfflineTts(runtime, {
        offlineTtsModelConfig: {
            offlineTtsKittenModelConfig: kitten,
            numThreads: 1,
            provider: "cpu",
            debug: 0,
        },
        maxNumSentences: 1,
    });

    if (
        !tts?.handle ||
        !Number.isSafeInteger(tts.numSpeakers) ||
        tts.numSpeakers <= TTS_SPEAKER ||
        tts.sampleRate !== TTS_SAMPLE_RATE
    ) {
        throw new Error("The local speech synthesizer could not load the expected Kitten voice.");
    }

    // Unlike ASR, synthesis reopens pronunciation data. Keep the TTS filesystem until teardown.
}

function validateAssets(manifest) {
    const { assets, runtime, model, tts: config } = manifest;
    const expected = [
        [runtime.script, "text/javascript; charset=utf-8", false],
        [runtime.wrapper, "text/javascript; charset=utf-8", false],
        [runtime.wasm, "application/wasm", false],
        [runtime.ttsWrapper, "text/javascript; charset=utf-8", false],
        [model.encoder, "application/octet-stream", false],
        [model.decoder, "application/octet-stream", false],
        [model.joiner, "application/octet-stream", false],
        [model.tokens, "text/plain; charset=utf-8", false],
        [config.model, "application/octet-stream", true],
        [config.voices, "application/octet-stream", true],
        [config.tokens, "application/octet-stream", true],
        [config.pronunciation?.asset, "application/octet-stream", true],
    ];
    const references = expected.map(([name]) => name);

    if (
        !/^victor-[a-f0-9]{64}$/.test(manifest.bundle) ||
        manifest.bundleBase !== `/victor-assets/${manifest.bundle}/` ||
        model.type !== "zipformer2" ||
        !Number.isSafeInteger(model.sampleRate) ||
        model.sampleRate <= 0 ||
        !Number.isSafeInteger(model.featureDim) ||
        model.featureDim <= 0 ||
        config.pronunciation?.asset !== "tts/pronunciation.data" ||
        !Array.isArray(assets) ||
        assets.length !== 12 ||
        new Set(references).size !== 12
    ) {
        throw new Error("The victor asset manifest layout is not supported.");
    }

    const names = new Set();

    for (const asset of assets) {
        const name = relativePath(asset.name);

        if (
            !name.split("/").every((part) => /^[a-zA-Z0-9_!][a-zA-Z0-9_.! -]*$/.test(part)) ||
            names.has(name) ||
            !references.includes(name) ||
            !Number.isSafeInteger(asset.bytes) ||
            asset.bytes <= 0 ||
            typeof asset.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(asset.sha256)
        ) {
            throw new Error("The victor asset manifest contains invalid assets.");
        }

        names.add(name);
    }

    for (const [name, contentType, nested] of expected) {
        if (
            typeof name !== "string" ||
            (nested ? !name.startsWith("tts/") : name.includes("/")) ||
            assets.find((asset) => asset.name === name)?.contentType !== contentType
        ) {
            throw new Error("The victor asset manifest contains invalid asset configuration.");
        }
    }
}

function validatePronunciation(manifest) {
    const { tts: config, assets } = manifest;
    const dataDir = ttsPath(config.dataDir);
    const index = config.pronunciation;

    if (!Array.isArray(assets) || !index || !Array.isArray(index.files) || !index.files.length) {
        throw new Error("The pronunciation index is incomplete.");
    }

    const direct = [config.model, config.voices, config.tokens].map(ttsPath);
    const packPath = ttsPath(index.asset);
    const matches = assets.filter((asset) => asset.name === index.asset);
    const asset = matches[0];

    if (
        matches.length !== 1 ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 0 ||
        typeof asset.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !direct.every((path) => assets.filter((item) => `/${item.name}` === path).length === 1)
    ) {
        throw new Error("The pronunciation pack or direct TTS assets are invalid.");
    }

    const paths = new Set([...direct, packPath]);
    const files = [];
    let end = 0;

    if (paths.size !== 4) {
        throw new Error("The pronunciation index contains a filesystem collision.");
    }

    for (const entry of index.files) {
        const path = ttsPath(`${config.dataDir}/${relativePath(entry.path)}`);

        if (
            !Number.isSafeInteger(entry.offset) ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 0 ||
            entry.offset !== end ||
            entry.bytes > asset.bytes - end
        ) {
            throw new Error("The pronunciation index contains an invalid range.");
        }

        if (paths.has(path)) {
            throw new Error("The pronunciation index contains a filesystem collision.");
        }

        end += entry.bytes;
        paths.add(path);
        files.push({ path, offset: entry.offset, bytes: entry.bytes });
    }

    if (end !== asset.bytes) {
        throw new Error("The pronunciation index does not cover the pack.");
    }

    // Check every ancestor, not adjacent sorted strings (punctuation can sort between them).
    for (const path of [...paths, dataDir]) {
        const parts = path.split("/");

        if (path === dataDir && paths.has(path)) {
            throw new Error("The pronunciation index contains a filesystem collision.");
        }

        while (parts.length > 2) {
            parts.pop();

            if (paths.has(parts.join("/"))) {
                throw new Error("The pronunciation index contains a filesystem collision.");
            }
        }
    }

    return { asset, files };
}

function relativePath(name) {
    if (
        typeof name !== "string" ||
        /[\\\\\u0000-\u001f\u007f]/.test(name) ||
        name.split("/").some((part) => !part || part === "." || part === "..")
    ) {
        throw new Error("The local speech synthesis manifest contains an invalid path.");
    }

    return name;
}

function ttsPath(name) {
    relativePath(name);

    if (!name.startsWith("tts/")) {
        throw new Error("The local speech synthesis manifest contains an invalid path.");
    }

    return `/${name}`;
}

function synthesize({ speechId, text, speed }) {
    if (!tts?.handle) {
        throw new Error("The local speech synthesizer is not ready.");
    }

    try {
        if (!Number.isSafeInteger(speechId) || typeof text !== "string" || !text.trim()) {
            throw new Error("Speech synthesis requires a request ID and nonempty text.");
        }

        // Kitten can end mid-sound on bare replies such as “Okay”; complete only the spoken input.
        text = text.trim();

        if (!/[.!?…]["'’”)\]]*$/.test(text)) {
            text += ".";
        }

        const rate = typeof speed === "string" ? Number(speed) : speed;
        const audio = tts.generateWithConfig(text, {
            sid: TTS_SPEAKER,
            speed: [0.75, 1, 1.25, 1.5].includes(rate) ? rate : 1.25,
            silenceScale: 1.0,
        });

        if (fatal) {
            return;
        }

        if (
            !(audio?.samples instanceof Float32Array) ||
            !audio.samples.length ||
            audio.sampleRate !== TTS_SAMPLE_RATE
        ) {
            throw new Error("The local speech synthesizer returned invalid audio.");
        }

        let nonzero = false;

        for (const sample of audio.samples) {
            if (!Number.isFinite(sample)) {
                throw new Error("The local speech synthesizer returned non-finite audio.");
            }

            nonzero ||= sample !== 0;
        }

        if (!nonzero) {
            throw new Error("The local speech synthesizer returned only silence.");
        }

        // Own this buffer even if an upstream wrapper starts returning views into WASM memory.
        const samples = new Float32Array(audio.samples);

        self.postMessage({ type: "synthesized", speechId, samples, sampleRate: audio.sampleRate }, [
            samples.buffer,
        ]);
    } catch (error) {
        if (fatal || error instanceof WebAssembly.RuntimeError) {
            reportError(error);

            return;
        }

        // A failed utterance does not discard an unfinished ASR stream or damage the runtime.
        self.postMessage({
            type: "synthesis-error",
            speechId,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

function discardStream() {
    const previous = active;

    active = null;
    previous?.stream.free();
}

function decode() {
    while (recognizer.isReady(active.stream)) {
        recognizer.decode(active.stream);
    }

    return recognizer.getResult(active.stream).text.trim();
}

function start({ turn, sampleRate }) {
    if (!recognizer) {
        throw new Error("The local speech recognizer is not ready.");
    }

    if (
        turn == null ||
        !Number.isSafeInteger(sampleRate) ||
        sampleRate < 8000 ||
        sampleRate > 384000
    ) {
        throw new Error("The microphone supplied an invalid turn or sample rate.");
    }

    discardStream();

    const stream = recognizer.createStream();

    if (!stream.handle) {
        throw new Error("Could not create a speech recognition stream.");
    }

    active = { turn, sampleRate, stream, text: "" };
    self.postMessage({ type: "started", turn });
}

function audio({ turn, samples }) {
    if (!(samples instanceof Float32Array)) {
        throw new Error("The microphone supplied invalid audio.");
    }

    try {
        if (!active || active.turn !== turn) {
            return;
        }

        if (samples.length > active.sampleRate) {
            throw new Error("Speech audio arrived in an oversized batch. Capture stopped.");
        }

        if (!samples.length) {
            return;
        }

        // sherpa keeps a stateful native resampler in this stream. Never resample per JS batch.
        active.stream.acceptWaveform(active.sampleRate, samples);

        const text = decode();

        if (text !== active.text) {
            active.text = text;
            self.postMessage({ type: "partial", turn, text });
        }
    } finally {
        self.postMessage({ type: "ack", turn, samples: samples.length });
    }
}

function finish(turn) {
    if (!active || active.turn !== turn) {
        return;
    }

    // Streaming Zipformer needs right context to emit its last words. Feed one second of
    // silence at the same input rate, then mark input complete and drain before freeing.
    active.stream.acceptWaveform(active.sampleRate, new Float32Array(active.sampleRate));
    active.stream.inputFinished();

    const text = decode();

    discardStream();
    self.postMessage({ type: "final", turn, text });
}

function reportError(error, turn) {
    if (fatal) {
        return;
    }

    fatal = true;
    self.postMessage({
        type: "error",
        ...(turn == null ? {} : { turn }),
        message: error instanceof Error ? error.message : String(error),
    });
}

self.onmessage = ({ data }) => {
    if (fatal) {
        return;
    }

    try {
        switch (data?.type) {
            case "init":
                // Retry by constructing a new worker: a failed WASM runtime is not reusable.
                initialization ||= initialize();
                initialization.then(
                    () => {
                        if (!fatal) {
                            self.postMessage({ type: "ready" });
                        }
                    },
                    (error) => reportError(error),
                );
                break;
            case "synthesize":
                synthesize(data);
                break;
            case "start":
                start(data);
                break;
            case "audio":
                audio(data);
                break;
            case "finish":
                finish(data.turn);
                break;
            case "discard":
                if (active?.turn === data.turn) {
                    discardStream();
                }

                break;
            default:
                throw new Error("Unknown speech worker message.");
        }
    } catch (error) {
        try {
            if (active?.turn === data?.turn) {
                discardStream();
            }
        } finally {
            reportError(error, data?.turn);
        }
    }
};
