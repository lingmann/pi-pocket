// Controller regressions with a stand-in worker and Web Audio graph. No model, microphone,
// server, or native speech engine runs here; real-engine qualification belongs to victor-input.js.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";

// As in voice.test.ts, replace only the controller's imports. Plain replies keep these tests
// about ownership and lifecycle, not Markdown rendering or sanitization.
const STUBS: Record<string, string> = {
    "./store.js": `
        const harness = () => globalThis.victorModeHarness;
        export const store = {
            get state() { return harness().state; },
            subscribe(listener) {
                const listeners = harness().listeners;
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        export const api = (...args) => harness().api(...args);
        export const drafts = { get: () => "" };
        export const notify = (...args) => harness().notices.push(args);
        export const uid = () => "request-" + ++harness().requestId;
    `,
    "./service-worker.js": `export const waitForWorkerControl = () => globalThis.victorModeHarness.waitForCache();`,
    "./ui.js": `export const replyText = (entry) => entry.text;`,
    "./voice.js": `
        export const setDictationBlocked = (blocked) => {
            globalThis.victorModeHarness.blocked = blocked;
        };
    `,
    marked: `export const marked = { parse: (text) => text };`,
    dompurify: `export default {
        sanitize: (textContent) => ({ textContent, querySelectorAll: () => [] }),
    };`,
};
const hooks = registerHooks({
    resolve(specifier, context, next) {
        const stub = STUBS[specifier];

        return stub !== undefined &&
            context.parentURL &&
            new URL(context.parentURL).pathname.endsWith("/web/victor-mode.js")
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

after(() => hooks.deregister());

type VictorState = {
    phase: string;
    text: string;
    message: string;
    hasReply: boolean;
    speed: number;
};
type VictorMode = {
    state: VictorState;
    active: boolean;
    enable: (options: { conversationId: string; preserveDraft: (text: string) => void }) => void;
    disable: () => void;
    readReply: () => void;
    setSpeed: (value: unknown) => void;
};
type Message = {
    type: string;
    turn?: number;
    speechId?: number;
    speed?: number;
    text?: string;
    samples?: Float32Array | number;
    sampleRate?: number;
    message?: string;
};
type Entry = { id: number; kind: string; text: string; stopReason?: string };
type Submission = {
    text: string;
    requestId: string;
    mode: string;
    attachments: unknown[];
    inlineFiles: boolean;
};

class Events {
    events = new Map<string, Set<() => void>>();

    addEventListener(type: string, callback: () => void) {
        if (!this.events.has(type)) {
            this.events.set(type, new Set());
        }

        this.events.get(type)!.add(callback);
    }

    removeEventListener(type: string, callback: () => void) {
        this.events.get(type)?.delete(callback);
    }

    emit(type: string) {
        for (const callback of this.events.get(type) ?? []) {
            callback();
        }
    }

    get listenerCount() {
        return [...this.events.values()].reduce((count, callbacks) => count + callbacks.size, 0);
    }
}

class Track extends Events {
    stopped = false;

    stop() {
        this.stopped = true;
        // Deliberately adversarial: teardown must invalidate ownership before callbacks fire.
        this.emit("ended");
    }
}

class Stream {
    track = new Track();

    getTracks() {
        return [this.track];
    }
}

class WorkerStub {
    onmessage: ((event: { data: Message }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessageerror: (() => void) | null = null;
    messages: Message[] = [];
    terminated = false;
    throwOnPost = false;

    postMessage(message: Message) {
        assert.equal(this.terminated, false, "never send to a terminated worker");

        if (this.throwOnPost) {
            throw new Error("worker unavailable");
        }

        this.messages.push(structuredClone(message));
    }

    terminate() {
        this.terminated = true;
    }

    emit(data: Message) {
        // Keep the handler even after terminate to exercise already queued events.
        this.onmessage?.({ data });
    }

    all(type: string) {
        return this.messages.filter((message) => message.type === type);
    }

    last(type: string) {
        const message = this.all(type).at(-1);

        assert.ok(message, `expected a ${type} request`);

        return message;
    }

    get turn() {
        return this.last("start").turn!;
    }
}

class Connection {
    disconnected = false;

    connect() {}

    disconnect() {
        this.disconnected = true;
    }
}

class Worklet extends Connection {
    port = {
        onmessage: null as ((event: { data: Message }) => void) | null,
        messages: [] as Message[],
        closed: false,
        postMessage(message: Message) {
            this.messages.push(message);
        },
        close() {
            this.closed = true;
        },
    };

    emit(data: Message) {
        this.port.onmessage?.({ data });
    }
}

class BufferStub {
    channels: number;
    length: number;
    sampleRate: number;
    copied: Float32Array | null = null;

    constructor(channels: number, length: number, sampleRate: number) {
        this.channels = channels;
        this.length = length;
        this.sampleRate = sampleRate;
    }

    get duration() {
        return this.length / this.sampleRate;
    }

    copyToChannel(samples: Float32Array, channel: number) {
        assert.equal(channel, 0);
        this.copied = samples.slice();
    }
}

class Playback extends Connection {
    buffer: BufferStub | null = null;
    playbackRate = { value: 1 };
    onended: (() => void) | null = null;
    queuedEnded: (() => void) | null = null;
    starts = 0;
    stops = 0;

    start() {
        this.starts++;
        this.queuedEnded = this.onended;
    }

    stop() {
        this.stops++;
        this.queuedEnded?.();
    }

    end() {
        this.queuedEnded?.();
    }
}

class AudioParamStub {
    values: number[] = [];

    setValueAtTime(value: number) {
        this.values.push(value);
    }

    exponentialRampToValueAtTime(value: number) {
        this.values.push(value);
    }

    linearRampToValueAtTime(value: number) {
        this.values.push(value);
    }
}

class Tone extends Connection {
    frequency = new AudioParamStub();
    onended: (() => void) | null = null;
    autoEnd = true;
    starts = 0;

    start() {
        this.starts++;
    }

    stop() {
        if (this.autoEnd) {
            queueMicrotask(() => this.onended?.());
        }
    }
}

class Audio extends Events {
    currentTime = 0;
    tones: Tone[] = [];
    gains: (Connection & { gain: AudioParamStub })[] = [];
    autoEndCues = true;
    cueFails = false;
    sampleRate = 48000;
    state = "suspended";
    destination = {};
    buffers: BufferStub[] = [];
    playbacks: Playback[] = [];
    sources: Connection[] = [];
    modules: string[] = [];
    audioWorklet = {
        addModule: async (url: string) => {
            this.modules.push(url);
        },
    };

    async resume() {
        this.state = "running";
    }

    async close() {
        this.state = "closed";
        this.emit("statechange");
    }

    suspend() {
        this.state = "suspended";
        this.emit("statechange");
    }

    createOscillator() {
        if (this.cueFails) {
            throw new Error("audio unavailable");
        }

        const tone = new Tone();

        tone.autoEnd = this.autoEndCues;
        this.tones.push(tone);

        return tone;
    }

    createGain() {
        const gain = Object.assign(new Connection(), { gain: new AudioParamStub() });

        this.gains.push(gain);

        return gain;
    }

    createMediaStreamSource() {
        const source = new Connection();

        this.sources.push(source);

        return source;
    }

    createBuffer(channels: number, length: number, rate: number) {
        const buffer = new BufferStub(channels, length, rate);

        this.buffers.push(buffer);

        return buffer;
    }

    createBufferSource() {
        const node = new Playback();

        this.playbacks.push(node);

        return node;
    }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });

    return { promise, resolve, reject };
}

// Drain promise continuations without advancing the fake watchdog clock.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
let moduleId = 0;

class Harness {
    victor!: VictorMode;
    modes: VictorMode[] = [];
    listeners = new Set<() => void>();
    page = Object.assign(new Events(), { hidden: false });
    window = new Events();
    state = {
        me: { id: "me", role: "owner", sessions: ["session"] },
        conversationId: "session",
        connection: "open",
        streamId: "stream",
        view: {
            conversation: { id: "session", kind: "session", pip: false },
            agent: {
                model: { provider: "faux", modelId: "faux-1" } as
                    { provider: string; modelId: string } | null | undefined,
                available: true,
            },
            turns: { on: false, driver: "me" },
            live: { busy: false },
            inbox: [] as unknown[],
            order: [] as number[],
            entries: new Map<number, Entry>(),
            authors: {} as Record<number, string>,
        },
    };
    storage = new Map<string, string>();
    readFails = false;
    writeFails = false;
    workers: WorkerStub[] = [];
    audios: Audio[] = [];
    worklets: Worklet[] = [];
    acquisitions: { stream: Stream; result: ReturnType<typeof deferred<Stream>> }[] = [];
    deferMicrophone = false;
    submissions: { path: string; body: Submission }[] = [];
    notices: [string, string][] = [];
    preserved: string[] = [];
    blocked = false;
    requestId = 0;
    startup: string[] = [];
    cacheWait: ReturnType<typeof deferred<void>> | null = null;
    persist: () => Promise<boolean> = async () => false;

    waitForCache() {
        this.startup.push("cache wait");

        return this.cacheWait?.promise ?? null;
    }

    async load() {
        const module = (await import(
            new URL(`../web/victor-mode.js?test=${++moduleId}`, import.meta.url).href
        )) as { victorMode: VictorMode };

        this.victor = module.victorMode;
        this.modes.push(this.victor);

        return this.victor;
    }

    async api(path: string, body: Submission) {
        assert.equal(path, "c/session/submit", "victor must never call Pi's abort endpoint");
        this.submissions.push({ path, body });
    }

    changed() {
        for (const listener of this.listeners) {
            listener();
        }
    }

    get worker() {
        return this.workers.at(-1)!;
    }

    get audio() {
        return this.audios.at(-1)!;
    }

    get capture() {
        return this.worklets.at(-1)!;
    }

    get playback() {
        return this.audio.playbacks.at(-1)!;
    }

    enable() {
        this.victor.enable({
            conversationId: "session",
            preserveDraft: (text) => this.preserved.push(text),
        });
        assert.equal(this.victor.state.phase, "preparing");
        assert.equal(this.audio.state, "running", "audio activates on the Victor tap");
        assert.deepEqual(this.worker.messages, [{ type: "init" }]);
    }

    async listen() {
        this.enable();
        this.worker.emit({ type: "ready" });
        await settle();
        assert.equal(this.victor.state.phase, "listening");
    }

    partial(text: string) {
        this.worker.emit({ type: "partial", turn: this.worker.turn, text });
    }

    async submit(text = "Hello Pi") {
        const count = this.submissions.length;

        this.partial(`${text} send it`);
        assert.equal(this.victor.state.phase, "submitting");
        assert.equal(this.capture.port.messages.at(-1)?.type, "flush");
        this.capture.emit({ type: "flushed" });
        assert.equal(this.worker.last("finish").turn, this.worker.turn);
        this.worker.emit({ type: "final", turn: this.worker.turn, text: `${text} send it` });
        this.worker.emit({ type: "final", turn: this.worker.turn, text: `${text} send it` });
        await settle();
        assert.equal(this.submissions.length, count + 1, "duplicate finals submit once");
        assert.equal(this.victor.state.phase, "waiting");
    }

    reply(text = "Hello from Pi", author: string | null = "me") {
        const { view } = this.state;
        const id = (view.order.at(-1) ?? 0) + 1;

        view.order.push(id, id + 1);
        view.entries.set(id, {
            id,
            kind: "user",
            text: this.submissions.at(-1)!.body.text,
        });
        view.entries.set(id + 1, { id: id + 1, kind: "assistant", text, stopReason: "stop" });

        if (author !== null) {
            view.authors[id] = author;
        }

        this.changed();

        return id;
    }

    async ask(text = "Hello Pi", answer = "Hello from Pi") {
        await this.submit(text);
        this.reply(answer);
        assert.equal(this.victor.state.phase, "speaking");
        assert.equal(this.victor.state.message, "Preparing speech…");
        assert.ok(this.acquisitions.every(({ stream }) => stream.track.stopped));

        return this.worker.last("synthesize");
    }

    synthesized(
        request = this.worker.last("synthesize"),
        samples = new Float32Array([0, 0.5, -0.5]),
    ) {
        this.worker.emit({
            type: "synthesized",
            speechId: request.speechId,
            samples,
            sampleRate: 24000,
        });
    }

    async finish() {
        this.synthesized();
        this.playback.end();
        await settle();
        assert.equal(this.victor.state.phase, "listening");
    }

    async released() {
        await settle();
        assert.ok(this.workers.every((worker) => worker.terminated));
        assert.ok(this.audios.every((audio) => audio.state === "closed"));
        assert.ok(this.acquisitions.every(({ stream }) => stream.track.stopped));
        assert.ok(this.worklets.every((node) => node.disconnected && node.port.closed));
        assert.ok(this.audios.flatMap((audio) => audio.sources).every((node) => node.disconnected));
        assert.ok(
            this.audios
                .flatMap((audio) => audio.playbacks)
                .every(
                    (node) => node.disconnected && node.buffer === null && node.onended === null,
                ),
        );
        assert.equal(this.listeners.size, 0);
        assert.equal(this.page.listenerCount, 0);
        assert.equal(this.window.listenerCount, 0);
    }
}

async function setup(
    t: TestContext,
    options: { saved?: string; readFails?: boolean; writeFails?: boolean } = {},
) {
    const h = new Harness();
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        victorModeHarness: h,
        isSecureContext: true,
        document: h.page,
        addEventListener: h.window.addEventListener.bind(h.window),
        removeEventListener: h.window.removeEventListener.bind(h.window),
        localStorage: {
            getItem(key: string) {
                if (h.readFails) {
                    throw new Error("storage blocked");
                }

                return h.storage.get(key) ?? null;
            },
            setItem(key: string, value: string) {
                if (h.writeFails) {
                    throw new Error("storage full");
                }

                h.storage.set(key, value);
            },
        },
        navigator: {
            storage: {
                persist() {
                    h.startup.push("persist");

                    return h.persist();
                },
            },
            mediaDevices: {
                getUserMedia() {
                    const stream = new Stream();
                    const result = deferred<Stream>();

                    h.acquisitions.push({ stream, result });

                    if (!h.deferMicrophone) {
                        result.resolve(stream);
                    }

                    return result.promise;
                },
            },
        },
        Worker: class extends WorkerStub {
            constructor(url: string) {
                super();
                assert.equal(url, "/victor-worker.js");
                h.workers.push(this);
                h.startup.push("worker");
            }
        },
        AudioContext: class extends Audio {
            constructor() {
                super();
                h.audios.push(this);
                h.startup.push("audio");
            }

            async resume() {
                h.startup.push("resume");
                await super.resume();
            }
        },
        AudioWorkletNode: class extends Worklet {
            constructor(audio: Audio, name: string) {
                super();
                assert.equal(audio, h.audio);
                assert.equal(name, "pocket-victor-capture");
                h.worklets.push(this);
            }
        },
    };

    t.mock.timers.enable({ apis: ["setTimeout"] });
    h.readFails = options.readFails ?? false;
    h.writeFails = options.writeFails ?? false;

    if (options.saved !== undefined) {
        h.storage.set("pocket.victor.speed", options.saved);
    }

    for (const [key, value] of Object.entries(globals)) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }

    t.after(async () => {
        try {
            for (const mode of h.modes) {
                mode.disable();
            }

            for (const { stream, result } of h.acquisitions) {
                result.resolve(stream);
            }

            await settle();
            await h.released();
            assert.equal(h.blocked, false);
            t.mock.timers.runAll();
            await settle();
            assert.ok(h.modes.every((mode) => mode.state.phase === "off"));
        } finally {
            t.mock.timers.reset();

            for (const [key, descriptor] of originals) {
                if (descriptor) {
                    Object.defineProperty(globalThis, key, descriptor);
                } else {
                    Reflect.deleteProperty(globalThis, key);
                }
            }
        }
    });
    await h.load();

    return h;
}

for (const missing of [undefined, null]) {
    test(`Victor refuses activation without a selected model (${String(missing)}) before loading assets`, async (t) => {
        const h = await setup(t);

        h.state.view.agent.model = missing;
        h.victor.enable({
            conversationId: "session",
            preserveDraft: (text) => h.preserved.push(text),
        });
        await settle();
        assert.equal(h.victor.active, false);
        assert.equal(h.victor.state.phase, "off");
        assert.deepEqual(h.notices, [["warning", "Pick a model before turning Victor on."]]);
        assert.deepEqual(
            h.startup,
            [],
            "no audio, persistence request, cache wait or worker loading",
        );
        assert.equal(h.workers.length, 0);
        assert.equal(h.audios.length, 0);
        assert.equal(h.acquisitions.length, 0);
        assert.equal(h.submissions.length, 0);
        assert.equal(h.blocked, false, "ordinary dictation stays available");
        h.state.view.agent.model = { provider: "faux", modelId: "faux-1" };
        await h.listen();
    });
}

test("Victor permits a selected model whose provider needs sign-in", async (t) => {
    const h = await setup(t);

    h.state.view.agent.available = false;
    await h.listen();
    assert.equal(h.victor.active, true);
    assert.equal(h.workers.length, 1);
});

test("distinct rising and falling cues bracket capture, including send it and replay", async (t) => {
    const h = await setup(t);

    h.enable();
    h.audio.autoEndCues = false;
    h.worker.emit({ type: "ready" });
    await settle();
    const start = h.audio.tones[0]!;

    assert.deepEqual(start.frequency.values, [660, 990]);
    assert.equal(start.starts, 1);
    assert.equal(h.worklets.length, 0, "the start cue is not recorded");
    assert.equal(h.audio.sources.length, 0);
    assert.deepEqual(h.audio.gains[0]!.gain.values, [0, 0.15, 0]);
    start.onended?.();
    await settle();
    assert.equal(h.worklets.length, 1);

    await h.submit();
    const stop = h.audio.tones[1]!;

    assert.deepEqual(stop.frequency.values, [440, 330]);
    assert.ok(h.acquisitions[0]!.stream.track.stopped);
    assert.ok(h.audio.sources[0]!.disconnected);
    assert.ok(h.capture.disconnected);
    stop.onended?.();
    h.audio.autoEndCues = true;
    h.reply();
    assert.equal(h.audio.tones.length, 2, "starting speech does not duplicate the stop cue");
    await h.finish();
    assert.deepEqual(h.audio.tones[2]!.frequency.values, [660, 990]);
    h.victor.readReply();
    assert.deepEqual(h.audio.tones[3]!.frequency.values, [440, 330]);
    h.victor.disable();
    assert.equal(h.audio.tones.length, 4, "disabling stopped capture does not beep again");
});

for (const reason of ["off", "hidden", "connection", "track ended", "worker failure"]) {
    test(`${reason} stops tracks immediately and lets exactly one stop cue finish`, async (t) => {
        const h = await setup(t);

        await h.listen();
        h.audio.autoEndCues = false;

        switch (reason) {
            case "off":
                h.victor.disable();
                break;
            case "hidden":
                h.page.hidden = true;
                h.page.emit("visibilitychange");
                break;
            case "connection":
                h.state.connection = "closed";
                h.changed();
                break;
            case "track ended":
                h.acquisitions[0]!.stream.track.emit("ended");
                break;
            case "worker failure":
                h.worker.onerror?.();
                break;
        }

        assert.ok(h.acquisitions[0]!.stream.track.stopped);
        assert.ok(h.worker.terminated);
        assert.equal(h.audio.state, "running", "do not cut off the stop cue");
        assert.equal(h.audio.tones.length, 2);
        assert.deepEqual(h.audio.tones[1]!.frequency.values, [440, 330]);
        h.victor.disable();
        assert.equal(h.audio.tones.length, 2);
        h.audio.tones[1]!.onended?.();
        await h.released();
    });
}

test("command-only send it waits for the stop cue before the next start cue", async (t) => {
    const h = await setup(t);

    await h.listen();
    h.audio.autoEndCues = false;
    h.partial("send it");
    h.capture.emit({ type: "flushed" });
    h.worker.emit({ type: "final", turn: h.worker.turn, text: "send it" });
    await settle();
    assert.equal(h.audio.tones.length, 2);
    assert.equal(h.worklets.length, 1);
    h.audio.tones[1]!.onended?.();
    await settle();
    assert.equal(h.audio.tones.length, 3);
    assert.equal(h.worklets.length, 1, "the new start cue must finish too");
    h.audio.tones[2]!.onended?.();
    await settle();
    assert.equal(h.worklets.length, 2);
    assert.deepEqual(h.submissions, []);
    h.audio.autoEndCues = true;
});

test("cancellation during the start cue cannot reopen capture or close a new context", async (t) => {
    const h = await setup(t);

    h.enable();
    h.audio.autoEndCues = false;
    h.worker.emit({ type: "ready" });
    await settle();
    const old = h.audio;

    h.victor.disable();
    assert.ok(h.acquisitions[0]!.stream.track.stopped);
    await h.listen();
    old.tones[0]!.onended?.();
    await settle();
    assert.equal(old.state, "closed");
    assert.equal(old.sources.length, 0);
    assert.equal(h.audio.state, "running");
    assert.equal(h.audio.sources.length, 1);
});

test("cue failure and missing ended events cannot stall capture or teardown", async (t) => {
    const h = await setup(t);

    h.enable();
    h.audio.cueFails = true;
    h.worker.emit({ type: "ready" });
    await settle();
    assert.equal(h.worklets.length, 1);
    h.audio.cueFails = false;
    h.audio.autoEndCues = false;
    h.victor.disable();
    t.mock.timers.tick(500);
    await h.released();
    assert.ok(h.audio.tones.every((tone) => tone.disconnected));
});

test("audio interrupted during the start cue cannot begin silent capture", async (t) => {
    const h = await setup(t);

    h.enable();
    h.audio.autoEndCues = false;
    h.worker.emit({ type: "ready" });
    await settle();
    h.audio.suspend();
    t.mock.timers.tick(500);
    await settle();
    assert.equal(h.victor.state.phase, "error");
    assert.match(h.victor.state.message, /Audio was interrupted/);
    assert.equal(h.worklets.length, 0);
    await h.released();
});

test("Victor activates audio synchronously before waiting for control and requesting persistence", async (t) => {
    const h = await setup(t);

    h.cacheWait = deferred<void>();
    h.persist = () => new Promise(() => {});
    h.victor.enable({ conversationId: "session", preserveDraft: () => {} });
    assert.equal(h.victor.state.phase, "preparing");
    assert.equal(h.audio.state, "running", "audio resumes in the original tap, not a continuation");
    assert.deepEqual(h.startup, ["audio", "resume", "persist", "cache wait"]);
    assert.equal(h.workers.length, 0);
    h.cacheWait.resolve();
    await settle();
    assert.equal(h.workers.length, 1, "persistence approval is not required");
    assert.deepEqual(h.worker.messages, [{ type: "init" }]);
    h.worker.emit({ type: "ready" });
    await settle();
    assert.equal(h.victor.state.phase, "listening");
});

test("persistence denial, rejection and synchronous failure never block Victor", async (t) => {
    for (const result of ["denied", "rejected", "throws"]) {
        await t.test(result, async (t) => {
            const h = await setup(t);

            h.persist = () => {
                if (result === "throws") {
                    throw new Error("persistence unavailable");
                }

                return result === "rejected"
                    ? Promise.reject(new Error("storage unavailable"))
                    : Promise.resolve(false);
            };

            await h.listen();
            assert.equal(h.notices.length, 0);
            assert.equal(h.worker.terminated, false);
            assert.deepEqual(h.startup.slice(0, 5), [
                "audio",
                "resume",
                "persist",
                "cache wait",
                "worker",
            ]);
        });
    }
});

test("a rejected cache readiness wait falls back to ordinary speech-worker loading", async (t) => {
    const h = await setup(t);

    h.cacheWait = deferred<void>();
    h.victor.enable({ conversationId: "session", preserveDraft: () => {} });
    h.cacheWait.reject(new Error("registration failed"));
    await settle();
    assert.deepEqual(h.worker.messages, [{ type: "init" }]);
    h.worker.emit({ type: "ready" });
    await settle();
    assert.equal(h.victor.state.phase, "listening");
});

test("teardown during cache installation prevents stale worker creation", async (t) => {
    for (const reason of ["off", "hidden", "pagehide", "connection", "ownership", "timeout"]) {
        await t.test(reason, async (t) => {
            const h = await setup(t);

            h.cacheWait = deferred<void>();
            h.victor.enable({ conversationId: "session", preserveDraft: () => {} });

            switch (reason) {
                case "off":
                    h.victor.disable();
                    break;
                case "hidden":
                    h.page.hidden = true;
                    h.page.emit("visibilitychange");
                    break;
                case "pagehide":
                    h.window.emit("pagehide");
                    break;
                case "connection":
                    h.state.connection = "closed";
                    h.changed();
                    break;
                case "ownership":
                    h.state.me.role = "viewer";
                    h.changed();
                    break;
                case "timeout":
                    t.mock.timers.tick(180000);
                    break;
            }

            assert.equal(h.victor.state.phase, reason === "timeout" ? "error" : "off");
            h.cacheWait.resolve();
            await settle();
            assert.equal(h.workers.length, 0);
            await h.released();
        });
    }
});

test("an old cache readiness continuation cannot create a worker in a new activation", async (t) => {
    const h = await setup(t);

    h.cacheWait = deferred<void>();
    const stale = h.cacheWait;

    h.victor.enable({ conversationId: "session", preserveDraft: () => {} });
    h.victor.disable();
    h.cacheWait = null;
    await h.listen();
    stale.resolve();
    await settle();
    assert.equal(h.workers.length, 1);
    assert.equal(h.worker.terminated, false);
    assert.equal(h.victor.state.phase, "listening");
});

test("speed defaults, saved offered rates, and invalid preferences", async (t) => {
    for (const saved of [
        undefined,
        "",
        "garbage",
        "NaN",
        "Infinity",
        "0",
        "1.2",
        "2",
        "-1",
        "0.75",
        "1",
        "1.25",
        "1.5",
    ]) {
        await t.test(`saved ${JSON.stringify(saved)}`, async (t) => {
            const h = await setup(t, { saved });
            const expected = ["0.75", "1", "1.25", "1.5"].includes(saved ?? "")
                ? Number(saved)
                : 1.25;

            assert.equal(h.victor.state.speed, expected);
            await h.listen();
            const request = await h.ask();

            assert.equal(request.speed, expected);
        });
    }
});

test("speed setters validate and persist only the rate across controller reloads", async (t) => {
    const h = await setup(t);

    for (const value of [0.75, "1", 1.25, "1.5", null, undefined, {}, NaN, Infinity, "fast", 2]) {
        const expected = [0.75, 1, 1.25, 1.5].includes(Number(value)) ? Number(value) : 1.25;

        h.victor.setSpeed(value);
        assert.equal(h.victor.state.speed, expected);
        assert.deepEqual([...h.storage], [["pocket.victor.speed", String(expected)]]);
        await h.load();
        assert.equal(h.victor.state.speed, expected);
    }
});

test("storage reads and writes may fail without disabling Victor", async (t) => {
    const h = await setup(t, { readFails: true, writeFails: true });

    assert.equal(h.victor.state.speed, 1.25);
    h.victor.setSpeed("1.5");
    assert.equal(h.victor.state.speed, 1.5);
    await h.listen();
    assert.equal((await h.ask()).speed, 1.5);
    await h.finish();
    assert.deepEqual([...h.storage], []);
});

test("two turns share one worker/context, submit once, and snapshot speed for the next reply", async (t) => {
    const h = await setup(t);

    await h.listen();
    const firstTurn = h.worker.turn;
    const first = await h.ask("First question");

    assert.equal(first.speed, 1.25);
    h.victor.setSpeed(0.75);
    assert.equal(first.speed, 1.25, "changing the preference cannot mutate a generation");
    await h.finish();
    assert.notEqual(h.worker.turn, firstTurn);
    assert.equal(h.victor.state.hasReply, true);
    const second = await h.ask("Second question");

    assert.equal(second.speed, 0.75);
    assert.notEqual(second.speechId, first.speechId);
    await h.finish();
    assert.equal(h.workers.length, 1);
    assert.equal(h.audios.length, 1);
    assert.equal(h.worker.all("init").length, 1);
    assert.equal(h.worker.all("start").length, 3);
    assert.equal(h.submissions.length, 2);
    assert.notEqual(h.submissions[0]!.body.requestId, h.submissions[1]!.body.requestId);
    assert.deepEqual(
        h.submissions.map(({ body }) => body.text),
        ["First question", "Second question"],
    );
    assert.ok(
        h.submissions.every(
            ({ body }) =>
                body.mode === "followUp" && !body.inlineFiles && body.attachments.length === 0,
        ),
    );
});

test("every offered rate is synthesized afresh; PCM uses 24 kHz and playbackRate 1", async (t) => {
    const h = await setup(t);

    await h.listen();
    await h.ask();
    await h.finish();

    for (const speed of [0.75, 1, 1.25, 1.5]) {
        h.victor.setSpeed(String(speed));
        h.victor.readReply();
        const request = h.worker.last("synthesize");
        const samples = new Float32Array([0, 0.5, -0.5]);

        assert.equal(request.speed, speed);
        h.victor.setSpeed(speed === 1.5 ? 0.75 : 1.5);
        h.synthesized(request, samples);
        const node = h.playback;
        const buffer = node.buffer!;

        assert.equal(buffer.channels, 1);
        assert.equal(buffer.sampleRate, 24000);
        assert.notEqual(buffer.sampleRate, h.audio.sampleRate);
        assert.deepEqual(buffer.copied, samples);
        assert.notEqual(buffer.copied, samples);
        assert.equal(node.playbackRate.value, 1);
        h.victor.setSpeed(1);
        assert.equal(node.playbackRate.value, 1, "preferences never pitch-shift playing audio");
        assert.equal(request.speed, speed);
        node.end();
        await settle();
        assert.equal(h.victor.state.phase, "listening");
        assert.equal(node.buffer, null);
    }

    assert.equal(h.submissions.length, 1, "Read reply never submits");
});

test("replay accepts late partials and preserves an unfinished draft and recognition stream", async (t) => {
    const h = await setup(t);

    await h.listen();
    await h.ask();
    await h.finish();
    h.partial("unfinished");
    const turn = h.worker.turn;
    const starts = h.worker.all("start").length;

    h.victor.readReply();
    h.partial("unfinished dictated draft");
    assert.equal(h.victor.state.text, "unfinished dictated draft");
    await h.finish();
    assert.equal(h.worker.turn, turn);
    assert.equal(h.worker.all("start").length, starts, "replay must not reset ASR's stream");
    assert.equal(h.victor.state.text, "unfinished dictated draft");
    h.victor.disable();
    assert.deepEqual(h.preserved, ["unfinished dictated draft"]);
    assert.equal(h.submissions.length, 1);
});

test("a late send-it partial during replay waits for the reopened capture before flushing", async (t) => {
    const h = await setup(t);

    await h.listen();
    await h.ask();
    await h.finish();
    h.partial("next question");
    h.victor.readReply();
    h.partial("next question send it");
    assert.equal(h.victor.state.phase, "speaking");
    assert.equal(h.submissions.length, 1);
    h.deferMicrophone = true;
    h.synthesized();
    h.playback.end();
    await settle();
    assert.equal(h.victor.state.phase, "listening");
    const acquisition = h.acquisitions.at(-1)!;

    acquisition.result.resolve(acquisition.stream);
    await settle();
    assert.equal(h.victor.state.phase, "submitting");
    assert.equal(h.capture.port.messages.at(-1)?.type, "flush");
    h.capture.emit({ type: "flushed" });
    h.worker.emit({ type: "final", turn: h.worker.turn, text: "next question send it" });
    await settle();
    assert.equal(h.submissions.length, 2);
    assert.equal(h.submissions[1]!.body.text, "next question");
});

for (const stage of ["generating", "playing"]) {
    test(`Victor off while ${stage} rejects late results, ended callbacks, and worker failures`, async (t) => {
        const h = await setup(t);

        await h.listen();
        const request = await h.ask();

        if (stage === "playing") {
            h.synthesized(request);
        }

        const node = h.playback;
        const acquisitions = h.acquisitions.length;

        h.victor.disable();
        h.synthesized(request);
        h.worker.emit({ type: "synthesis-error", speechId: request.speechId, message: "late" });
        h.worker.emit({ type: "ready" });
        h.worker.onerror?.();
        node?.end();
        t.mock.timers.tick(300000);
        await settle();
        assert.equal(h.victor.state.phase, "off");
        assert.equal(h.acquisitions.length, acquisitions);
        assert.equal(h.audio.playbacks.length, stage === "playing" ? 1 : 0);
        assert.equal(h.submissions.length, 1);
        assert.deepEqual(h.preserved, [], "an already sent message is not restored as a duplicate");
        await h.released();
    });
}

test("duplicate results and old ended callbacks cannot finish a newer speech request", async (t) => {
    const h = await setup(t);

    await h.listen();
    const first = await h.ask();

    h.synthesized(first);
    const oldNode = h.playback;

    h.synthesized(first);
    h.worker.emit({ type: "synthesis-error", speechId: first.speechId, message: "duplicate" });
    assert.equal(h.audio.playbacks.length, 1);
    assert.equal(h.victor.state.phase, "speaking");
    oldNode.end();
    await settle();
    const acquisitions = h.acquisitions.length;

    oldNode.end();
    h.synthesized(first);
    assert.equal(h.acquisitions.length, acquisitions);
    h.victor.readReply();
    const next = h.worker.last("synthesize");

    assert.notEqual(next.speechId, first.speechId);
    oldNode.end();
    h.synthesized(first);
    assert.equal(h.victor.state.message, "Preparing speech…");
    h.synthesized(next);
    oldNode.end();
    assert.equal(h.victor.state.phase, "speaking");
    assert.equal(h.acquisitions.length, acquisitions);
    h.playback.end();
    await settle();
    assert.equal(h.acquisitions.length, acquisitions + 1);
});

test("an old activation cannot affect a newly enabled worker or playback", async (t) => {
    const h = await setup(t);

    await h.listen();
    await h.ask();
    h.synthesized();
    const oldWorker = h.worker;
    const oldNode = h.playback;

    h.victor.disable();
    await h.listen();
    const next = await h.ask("New activation");
    const captures = h.acquisitions.length;

    oldWorker.emit({
        type: "synthesized",
        speechId: next.speechId,
        samples: new Float32Array([1]),
        sampleRate: 24000,
    });
    oldWorker.emit({ type: "partial", turn: h.worker.turn, text: "wrong send it" });
    oldWorker.onerror?.();
    oldNode.end();
    assert.equal(h.victor.state.message, "Preparing speech…");
    assert.equal(h.audio.playbacks.length, 0);
    h.synthesized(next);
    oldNode.end();
    assert.equal(h.victor.state.phase, "speaking");
    assert.equal(h.acquisitions.length, captures);
    assert.equal(h.submissions.length, 2);
});

test("a synthesis error resumes listening and permits retry with the draft intact", async (t) => {
    const h = await setup(t);

    await h.listen();
    const first = await h.ask();

    h.worker.emit({
        type: "synthesis-error",
        speechId: first.speechId,
        message: "temporary failure",
    });
    await settle();
    assert.equal(h.victor.state.phase, "listening");
    assert.equal(h.victor.state.hasReply, true);
    assert.equal(h.worker.terminated, false);
    assert.match(h.notices.at(-1)![1], /Speech failed.*Read reply/);
    h.partial("keep this draft");
    const turn = h.worker.turn;

    h.victor.readReply();
    const retry = h.worker.last("synthesize");

    h.worker.emit({ type: "synthesis-error", speechId: retry.speechId, message: "retry failed" });
    await settle();
    assert.equal(h.worker.turn, turn);
    assert.equal(h.victor.state.text, "keep this draft");
    h.victor.readReply();
    await h.finish();
    assert.equal(h.victor.state.text, "keep this draft");
});

test("invalid generated PCM is recoverable, never played", async (t) => {
    for (const [name, samples, sampleRate] of [
        ["empty", new Float32Array(), 24000],
        ["silent", new Float32Array([0, 0]), 24000],
        ["nonfinite", new Float32Array([1, NaN]), 24000],
        ["wrong rate", new Float32Array([1]), 48000],
    ] as const) {
        await t.test(name, async (t) => {
            const h = await setup(t);

            await h.listen();
            const request = await h.ask();

            h.worker.emit({ type: "synthesized", speechId: request.speechId, samples, sampleRate });
            await settle();
            assert.equal(h.victor.state.phase, "listening");
            assert.equal(h.audio.playbacks.length, 0);
            assert.equal(h.worker.terminated, false);
            assert.match(h.notices.at(-1)![1], /invalid audio/);
        });
    }
});

test("playback watchdog uses buffer duration and recovers only once", async (t) => {
    const h = await setup(t);

    await h.listen();
    const request = await h.ask();

    h.synthesized(request, new Float32Array(24000 * 25).fill(0.1));
    t.mock.timers.tick(34999);
    assert.equal(h.victor.state.phase, "speaking", "generation's 30-second timer was cleared");
    t.mock.timers.tick(1);
    await settle();
    assert.equal(h.victor.state.phase, "listening");
    assert.match(h.notices.at(-1)![1], /Playback stalled/);
    const acquisitions = h.acquisitions.length;

    h.playback.end();
    h.synthesized(request);
    assert.equal(h.acquisitions.length, acquisitions);
    assert.equal(h.worker.terminated, false);
});

test("generation deadlines are length-aware, capped, and fatal to the blocked worker", async (t) => {
    for (const [length, deadline] of [
        [10, 30000],
        [600, 57600],
        [4000, 180000],
    ]) {
        await t.test(`${length} characters: ${deadline} ms`, async (t) => {
            const h = await setup(t);

            await h.listen();
            const request = await h.ask("question", "x".repeat(length!));
            const acquisitions = h.acquisitions.length;

            t.mock.timers.tick(deadline! - 1);
            assert.equal(h.victor.state.phase, "speaking");
            t.mock.timers.tick(1);
            assert.equal(h.victor.state.phase, "error");
            assert.match(h.victor.state.message, /generation took too long/);
            h.synthesized(request);
            h.worker.emit({ type: "synthesis-error", speechId: request.speechId, message: "late" });
            await settle();
            assert.equal(h.acquisitions.length, acquisitions);
            await h.released();
        });
    }
});

for (const failure of ["abort", "worker", "message", "post"]) {
    test(`${failure} failure is fatal, not a recoverable synthesis error`, async (t) => {
        const h = await setup(t);

        await h.listen();
        const request = await h.ask();
        const acquisitions = h.acquisitions.length;

        if (failure === "abort") {
            h.worker.emit({ type: "error", message: "WASM aborted" });
        } else if (failure === "worker") {
            h.worker.onerror?.();
        } else if (failure === "message") {
            h.worker.onmessageerror?.();
        } else {
            await h.finish();
            h.worker.throwOnPost = true;
            h.victor.readReply();
        }

        assert.equal(h.victor.state.phase, "error");
        h.synthesized(request);
        h.playback?.end();
        await settle();
        assert.equal(h.acquisitions.length, acquisitions + (failure === "post" ? 1 : 0));
        assert.equal(h.submissions.length, 1);
        await h.released();
    });
}

test("a fatal error from an earlier turn tears down the shared runtime and current playback", async (t) => {
    const h = await setup(t);

    await h.listen();
    const staleTurn = h.worker.turn;

    await h.ask();
    await h.finish();
    assert.notEqual(h.worker.turn, staleTurn);
    h.partial("keep this draft");
    h.victor.readReply();
    const request = h.worker.last("synthesize");

    h.synthesized(request);
    const node = h.playback;
    const acquisitions = h.acquisitions.length;

    h.worker.emit({ type: "partial", turn: staleTurn, text: "stale words send it" });
    assert.equal(h.victor.state.text, "keep this draft", "ordinary stale results remain ignored");
    h.worker.emit({ type: "error", turn: staleTurn, message: "Shared WASM runtime aborted" });
    assert.equal(h.victor.state.phase, "error");
    assert.match(h.victor.state.message, /Shared WASM runtime aborted/);
    await h.released();
    h.synthesized(request);
    node.end();
    await settle();
    assert.equal(h.victor.state.phase, "error");
    assert.equal(h.acquisitions.length, acquisitions);
    assert.equal(h.submissions.length, 1);
    h.victor.disable();
    assert.deepEqual(h.preserved, ["keep this draft"]);
});

for (const stage of ["listening", "generating", "playing"]) {
    test(`suspended context during ${stage} stops and keeps an unsent draft`, async (t) => {
        const h = await setup(t);

        await h.listen();

        if (stage !== "listening") {
            await h.ask();
            await h.finish();
        }

        h.partial("unsent draft");

        if (stage !== "listening") {
            h.victor.readReply();
        }

        if (stage === "playing") {
            h.synthesized();
        }

        const acquisitions = h.acquisitions.length;

        h.audio.suspend();
        assert.equal(h.victor.state.phase, "error");
        h.playback?.end();
        await settle();
        assert.equal(h.acquisitions.length, acquisitions);
        await h.released();
        h.victor.disable();
        assert.deepEqual(h.preserved, ["unsent draft"]);
    });
}

const lifecycleChanges: Record<string, (h: Harness) => void> = {
    navigation: (h) => {
        h.state.conversationId = "elsewhere";
        h.changed();
    },
    hidden: (h) => {
        h.page.hidden = true;
        h.page.emit("visibilitychange");
    },
    pagehide: (h) => h.window.emit("pagehide"),
    disconnect: (h) => {
        h.state.connection = "closed";
        h.changed();
    },
    reconnect: (h) => {
        h.state.streamId = "another-stream";
        h.changed();
    },
    role: (h) => {
        h.state.me.role = "viewer";
        h.changed();
    },
    sessions: (h) => {
        h.state.me.sessions = [];
        h.changed();
    },
    wheel: (h) => {
        h.state.view.turns = { on: true, driver: "someone-else" };
        h.changed();
    },
};

test("navigation, visibility, connection and permission changes tear down replay", async (t) => {
    for (const [name, change] of Object.entries(lifecycleChanges)) {
        for (const stage of ["generating", "playing"]) {
            await t.test(`${name} while ${stage}`, async (t) => {
                const h = await setup(t);

                await h.listen();
                await h.ask();
                await h.finish();
                h.partial("unfinished draft");
                h.victor.readReply();
                const request = h.worker.last("synthesize");

                if (stage === "playing") {
                    h.synthesized(request);
                }

                const acquisitions = h.acquisitions.length;
                const node = h.playback;

                change(h);
                assert.equal(h.victor.state.phase, "off");
                assert.deepEqual(h.preserved, ["unfinished draft"]);
                h.synthesized(request);
                node.end();
                await settle();
                assert.equal(h.acquisitions.length, acquisitions);
                assert.equal(h.submissions.length, 1);
                await h.released();
            });
        }
    }
});

test("a reply is not synthesized until its user entry is attributable to us", async (t) => {
    const h = await setup(t);

    await h.listen();
    await h.submit();
    const id = h.reply("Attributed answer", null);

    assert.equal(h.victor.state.phase, "waiting");
    assert.equal(h.worker.all("synthesize").length, 0);
    h.state.view.authors[id] = "me";
    h.changed();
    assert.equal(h.worker.last("synthesize").text, "Attributed answer");
    h.changed();
    assert.equal(h.worker.all("synthesize").length, 1);
});

test("another person's matching message cannot own this reply", async (t) => {
    const h = await setup(t);

    await h.listen();
    await h.submit();
    h.reply("Not ours", "another-person");
    assert.equal(h.victor.state.phase, "off");
    assert.equal(h.worker.all("synthesize").length, 0);
    assert.deepEqual(h.preserved, []);
    await h.released();
});

test("stale microphone acquisitions during replay are stopped without replacing the new capture", async (t) => {
    const h = await setup(t);

    await h.listen();
    await h.ask();
    h.deferMicrophone = true;
    await h.finish();
    const stale = h.acquisitions.at(-1)!;

    h.victor.readReply();
    await h.finish();
    const current = h.acquisitions.at(-1)!;

    current.result.resolve(current.stream);
    await settle();
    const capture = h.capture;

    stale.result.resolve(stale.stream);
    await settle();
    assert.equal(stale.stream.track.stopped, true);
    assert.equal(current.stream.track.stopped, false);
    assert.equal(h.capture, capture);
    assert.equal(h.victor.state.phase, "listening");
    h.victor.disable();
    assert.equal(current.stream.track.stopped, true);
});

test("an acquisition from a disabled activation cannot install a worklet or fail the new activation", async (t) => {
    for (const outcome of ["resolve", "reject"]) {
        await t.test(outcome, async (t) => {
            const h = await setup(t);

            h.deferMicrophone = true;
            await h.listen();
            const stale = h.acquisitions.at(-1)!;

            h.victor.disable();
            h.deferMicrophone = false;
            await h.listen();
            const count = h.worklets.length;

            if (outcome === "resolve") {
                stale.result.resolve(stale.stream);
            } else {
                // No stream is handed to the controller when permission rejects.
                stale.stream.track.stop();
                stale.result.reject(new Error("old permission request rejected"));
            }

            await settle();
            assert.equal(stale.stream.track.stopped, true);
            assert.equal(h.worklets.length, count);
            assert.equal(h.victor.state.phase, "listening");
            assert.equal(h.worker.terminated, false);
        });
    }
});

test("stale worklet callbacks and track-ended events cannot mutate the resumed capture", async (t) => {
    const h = await setup(t);

    await h.listen();
    await h.ask();
    await h.finish();
    const stale = h.capture;
    const track = h.acquisitions.at(-1)!.stream.track;

    h.partial("keep this");
    h.victor.readReply();
    await h.finish();
    const count = h.worker.messages.length;
    const current = h.capture;

    for (const message of [
        { type: "audio", samples: new Float32Array([1]) },
        { type: "flushed" },
        { type: "overload", message: "old overload" },
        { type: "error", message: "old error" },
    ]) {
        stale.emit(message);
    }

    track.emit("ended");
    assert.equal(h.worker.messages.length, count);
    assert.equal(h.victor.state.phase, "listening");
    assert.equal(h.victor.state.text, "keep this");
    assert.equal(current.disconnected, false);
    current.emit({ type: "audio", samples: new Float32Array([0.1]) });
    assert.equal(h.worker.last("audio").turn, h.worker.turn);
    h.victor.disable();
    current.emit({ type: "flushed" });
    assert.equal(h.victor.state.phase, "off");
});
