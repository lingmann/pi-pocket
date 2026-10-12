// Loaded only by test/serve.ts with POCKET_VICTOR_FIXTURE set. Both speech engines remain real.
// Install before turning Victor on. Times are performance.now() milliseconds; audio durations are seconds.
export async function installVictorInput({ turns = 1 } = {}) {
    const { victorMode } = await import("/victor-mode.js");
    const { store } = await import("/store.js");

    if (victorMode.active) {
        throw new Error("Install the victor observer before turning Victor on.");
    }

    const wav = await (await fetch("/__test/victor.wav")).arrayBuffer();
    const baseline = new Set(store.state.view.order);
    const states = [];
    const submissions = [];
    const speech = [];
    const playbacks = [];
    const workers = [];
    const contexts = [];
    const inputs = [];
    const unexpectedSpeechSynthesis = [];
    const results = [];
    const samplesToResult = new WeakMap();
    const buffersToResult = new WeakMap();
    const restoreSpeech = [];
    const original = {
        fetch: window.fetch,
        Worker: window.Worker,
        AudioContext: window.AudioContext,
        getUserMedia: navigator.mediaDevices.getUserMedia,
    };
    const tracks = () =>
        inputs.map((input) => input.stream.getTracks().map((track) => track.readyState));
    const unsubscribe = victorMode.subscribe((state) =>
        states.push({ at: performance.now(), ...state }),
    );

    window.fetch = async (input, options) => {
        const response = await original.fetch.call(window, input, options);

        if (String(input).endsWith("/submit")) {
            submissions.push({
                path: String(input),
                body: JSON.parse(options.body),
                status: response.status,
            });
        }

        return response;
    };

    window.Worker = class extends original.Worker {
        constructor(...args) {
            super(...args);
            const record = {
                id: workers.length,
                url: String(args[0]),
                at: performance.now(),
                terminated: false,
                terminatedAt: null,
                sent: {},
                received: {},
                events: [],
            };
            const requests = new Map();

            workers.push(record);

            this.postMessage = (data, ...options) => {
                record.sent[data.type] = (record.sent[data.type] ?? 0) + 1;

                if (data.type === "synthesize") {
                    const request = {
                        workerId: record.id,
                        speechId: data.speechId,
                        text: data.text,
                        speed: data.speed,
                        requestedAt: performance.now(),
                        tracks: tracks(),
                        pcmAt: null,
                        pcmMs: null,
                        firstPlaybackAt: null,
                        firstPlaybackMs: null,
                        responses: [],
                        events: [],
                    };

                    speech.push(request);
                    requests.set(data.speechId, request);
                }

                return original.Worker.prototype.postMessage.call(this, data, ...options);
            };

            // Observe before the controller's onmessage without replacing its handler or message.
            this.addEventListener("message", ({ data }) => {
                record.received[data.type] = (record.received[data.type] ?? 0) + 1;

                if (!["ready", "synthesized", "synthesis-error", "error"].includes(data.type)) {
                    return;
                }

                const response = {
                    type: data.type,
                    at: performance.now(),
                    speechId: data.speechId,
                    message: data.message,
                    afterTermination: record.terminated,
                };
                const request = requests.get(data.speechId);

                record.events.push(response);

                if (data.type === "synthesized") {
                    response.pcm = pcmStats(data.samples, data.sampleRate);
                    response.requestToPcmMs = request ? response.at - request.requestedAt : null;
                    const result = { request, response };

                    results.push(result);

                    if (data.samples instanceof Float32Array) {
                        samplesToResult.set(data.samples, result);
                    }

                    if (request && request.pcmAt === null) {
                        request.pcmAt = response.at;
                        request.pcmMs = response.requestToPcmMs;
                    }
                }

                if (request) {
                    request.responses.push(response);
                }
            });

            for (const type of ["error", "messageerror"]) {
                this.addEventListener(type, (event) =>
                    record.events.push({
                        type: `${type}-event`,
                        at: performance.now(),
                        message: event.message,
                    }),
                );
            }

            this.terminate = () => {
                record.terminated = true;
                record.terminatedAt = performance.now();
                record.events.push({ type: "terminate", at: record.terminatedAt });

                return original.Worker.prototype.terminate.call(this);
            };
        }
    };

    window.AudioContext = class extends original.AudioContext {
        constructor(...args) {
            super(...args);
            const context = this;
            const record = {
                id: contexts.length,
                at: performance.now(),
                sampleRate: context.sampleRate,
                state: context.state,
                events: [],
            };
            const createBuffer = context.createBuffer;
            const createBufferSource = context.createBufferSource;

            contexts.push(record);
            context.addEventListener("statechange", () => {
                record.state = context.state;
                record.events.push({ at: performance.now(), state: context.state });
            });

            context.createBuffer = (...options) => {
                const buffer = createBuffer.apply(context, options);
                const copyToChannel = buffer.copyToChannel;

                buffer.copyToChannel = (samples, ...channel) => {
                    const result = copyToChannel.call(buffer, samples, ...channel);
                    const synthesis = samplesToResult.get(samples);

                    if (synthesis) {
                        buffersToResult.set(buffer, synthesis);
                    }

                    return result;
                };

                return buffer;
            };

            context.createBufferSource = (...options) => {
                const source = createBufferSource.apply(context, options);
                const playback = {
                    id: playbacks.length,
                    contextId: record.id,
                    workerId: null,
                    speechId: null,
                    events: [],
                };
                let request = null;

                const observe = (type, details = {}) => {
                    const event = {
                        type,
                        at: performance.now(),
                        playbackId: playback.id,
                        contextTime: context.currentTime,
                        contextState: context.state,
                        tracks: tracks(),
                        ...details,
                    };

                    playback.events.push(event);
                    request?.events.push(event);

                    return event;
                };

                const start = source.start;

                playbacks.push(playback);

                source.start = (...startArgs) => {
                    const buffer = source.buffer;
                    const pcm = pcmStats(buffer?.getChannelData(0), buffer?.sampleRate);
                    // copyToChannel preserves identity. Match PCM when the app uses getChannelData().set().
                    const synthesis =
                        buffersToResult.get(buffer) ??
                        results.findLast((result) => samePcm(result.response.pcm, pcm));

                    request = synthesis?.request ?? null;
                    playback.workerId = request?.workerId ?? null;
                    playback.speechId = request?.speechId ?? null;
                    playback.pcm = pcm;
                    playback.channels = buffer?.numberOfChannels;
                    playback.playbackRate = source.playbackRate.value;
                    playback.detune = source.detune.value;

                    try {
                        const result = start.apply(source, startArgs);
                        // Web Audio has no start event: this records the successful native start call,
                        // not audible output or device latency. The native ended event is observed below.
                        const event = observe("start", {
                            when: startArgs[0] ?? 0,
                            offset: startArgs[1] ?? 0,
                            duration: startArgs[2] ?? null,
                            requestToPlaybackMs: request
                                ? performance.now() - request.requestedAt
                                : null,
                        });

                        if (request && request.firstPlaybackAt === null) {
                            request.firstPlaybackAt = event.at;
                            request.firstPlaybackMs = event.at - request.requestedAt;
                        }

                        return result;
                    } catch (error) {
                        observe("start-error", { message: error.message });

                        throw error;
                    }
                };

                for (const method of ["stop", "disconnect"]) {
                    const native = source[method];

                    source[method] = (...methodArgs) => {
                        try {
                            const result = native.apply(source, methodArgs);

                            observe(method);

                            return result;
                        } catch (error) {
                            observe(`${method}-error`, { message: error.message });

                            throw error;
                        }
                    };
                }

                source.addEventListener("ended", () => observe("end"));

                return source;
            };
        }
    };

    // No system speech API is part of the expected path, including voice lookup and empty priming.
    const nativeSpeech = window.speechSynthesis;

    for (const method of [
        "speak",
        "cancel",
        "pause",
        "resume",
        "getVoices",
        "addEventListener",
        "removeEventListener",
        "dispatchEvent",
    ]) {
        if (typeof nativeSpeech?.[method] !== "function") {
            continue;
        }

        const native = nativeSpeech[method];
        const descriptor = Object.getOwnPropertyDescriptor(nativeSpeech, method);

        nativeSpeech[method] = (...args) => {
            unexpectedSpeechSynthesis.push({
                unexpected: true,
                method,
                at: performance.now(),
                text: method === "speak" ? args[0]?.text : undefined,
                event: method.endsWith("EventListener") ? args[0] : undefined,
            });

            return native.apply(nativeSpeech, args);
        };

        restoreSpeech.push(() => {
            if (descriptor) {
                Object.defineProperty(nativeSpeech, method, descriptor);
            } else {
                delete nativeSpeech[method];
            }
        });
    }

    navigator.mediaDevices.getUserMedia = async () => {
        // Bypass the observer: these sources play the microphone fixture, not Pi's replies.
        const context = new original.AudioContext();
        const buffer = await context.decodeAudioData(wav.slice(0));
        const source = context.createBufferSource();
        const destination = context.createMediaStreamDestination();

        source.buffer = buffer;
        source.connect(destination);
        await context.resume();
        const input = { context, stream: destination.stream, unsubscribe: null };

        inputs.push(input);
        // Play only after the production capture graph is connected, not during its initialization.
        input.unsubscribe = victorMode.subscribe((state) => {
            if (state.phase === "listening" && state.message.startsWith("Listening.")) {
                input.unsubscribe();

                if (turns-- > 0) {
                    source.start(context.currentTime + 1);
                }
            }
        });

        return destination.stream;
    };

    return {
        report() {
            return {
                state: victorMode.state,
                states,
                submissions,
                speech,
                playbacks,
                workers,
                contexts,
                unexpectedSpeechSynthesis,
                tracks: tracks(),
                entries: [...store.state.view.entries.values()].filter(
                    (entry) => !baseline.has(entry.id),
                ),
                crossOriginIsolated,
                layout: { width: innerWidth, scrollWidth: document.documentElement.scrollWidth },
                resources: performance.getEntriesByType("resource").map((entry) => entry.name),
            };
        },
        async dispose() {
            victorMode.disable();
            unsubscribe();
            window.fetch = original.fetch;
            window.Worker = original.Worker;
            window.AudioContext = original.AudioContext;
            navigator.mediaDevices.getUserMedia = original.getUserMedia;
            restoreSpeech.forEach((restore) => restore());

            for (const input of inputs) {
                input.unsubscribe();
                input.stream.getTracks().forEach((track) => track.stop());
                await input.context.close();
            }
        },
    };
}

// Keep statistics rather than PCM references so observing repeated replies does not retain their audio.
function pcmStats(samples, sampleRate) {
    const float32 = samples instanceof Float32Array;
    const length = float32 ? samples.length : 0;
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null;
    const bits = float32
        ? new Uint32Array(samples.buffer, samples.byteOffset, samples.length)
        : null;
    let finite = float32;
    let peak = 0;
    let sumSquares = 0;
    let hash = 2166136261;

    for (let index = 0; index < length; index++) {
        const sample = samples[index];
        const word = bits[index];

        // Mix each byte: hashing whole words would lose distinctions between some sign changes.
        hash = Math.imul(hash ^ (word & 255), 16777619) >>> 0;
        hash = Math.imul(hash ^ ((word >>> 8) & 255), 16777619) >>> 0;
        hash = Math.imul(hash ^ ((word >>> 16) & 255), 16777619) >>> 0;
        hash = Math.imul(hash ^ (word >>> 24), 16777619) >>> 0;

        if (!Number.isFinite(sample)) {
            finite = false;
            continue;
        }

        peak = Math.max(peak, Math.abs(sample));
        sumSquares += sample * sample;
    }

    return {
        float32,
        length,
        nonempty: length > 0,
        finite,
        peak,
        rms: finite && length ? Math.sqrt(sumSquares / length) : null,
        nonSilent: peak > 0,
        sampleRate: rate,
        duration: rate ? length / rate : null,
        hash: hash.toString(16),
    };
}

function samePcm(left, right) {
    return (
        left.nonempty &&
        right.nonempty &&
        left.length === right.length &&
        left.sampleRate === right.sampleRate &&
        left.hash === right.hash
    );
}
