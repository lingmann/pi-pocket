// The real Victor controller, with browser audio and native speech stood in for; no models or app data.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import { setImmediate as settle } from "node:timers/promises";

const STUBS: Record<string, string> = {
    "./store.js": `
        const env = () => globalThis.victorListening;
        export const store = {
            get state() { return env().state; },
            subscribe(fn) {
                const listeners = env().listeners;
                listeners.add(fn);
                return () => listeners.delete(fn);
            },
        };
        export const drafts = { get: () => "" };
        export const api = async (path, body) => env().submissions.push({ path, body });
        export const uid = () => "victor-request";
        export const notify = () => {};
    `,
    "./voice.js": `export const setDictationBlocked = () => {};`,
    "./service-worker.js": `export const waitForWorkerControl = () => null;`,
    "./ui.js": `export const replyText = () => { throw Error("No reply expected"); };`,
    dompurify: `export default { sanitize() { throw Error("No reply expected"); } };`,
    marked: `export const marked = { parse() { throw Error("No reply expected"); } };`,
};

registerHooks({
    resolve(specifier, context, next) {
        const stub = STUBS[specifier];

        return stub !== undefined && context.parentURL?.endsWith("/web/victor-mode.js")
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

const { victorMode } = (await import(new URL("../web/victor-mode.js", import.meta.url).href)) as {
    victorMode: {
        state: { phase: string; text: string; message: string };
        enable(options: { conversationId: string; preserveDraft(text: string): void }): void;
        disable(): void;
    };
};

type Message = {
    type: string;
    turn?: number;
    text?: string;
    samples?: Float32Array | number;
    message?: string;
};

class Port {
    onmessage: ((event: { data: Message }) => void) | null = null;
    messages: Message[] = [];
    closed = false;

    postMessage(data: Message) {
        this.messages.push(data);
    }

    emit(data: Message) {
        this.onmessage?.({ data });
    }

    close() {
        this.closed = true;
    }
}

class AudioNode {
    target: unknown = null;

    connect(target: unknown) {
        this.target = target;
    }

    disconnect() {
        this.target = null;
    }
}

/** Only setTimeout is faked. settle() drains microphone/API promises without advancing any deadline. */
function harness(t: TestContext) {
    t.mock.timers.enable({ apis: ["setTimeout"] });

    const env = {
        state: {
            connection: "open",
            conversationId: "session",
            streamId: "stream",
            me: { id: "owner", role: "owner" },
            view: {
                conversation: { id: "session", kind: "session", pip: false },
                agent: { model: { provider: "faux", modelId: "faux-1" } },
                turns: { on: true, driver: "owner" },
                live: { busy: false },
                inbox: [],
                order: [],
                entries: new Map(),
                authors: {},
            },
        },
        listeners: new Set<() => void>(),
        submissions: [] as { path: string; body: unknown }[],
    };
    const preserved: string[] = [];
    const page = Object.assign(new EventTarget(), { hidden: false });
    const window = new EventTarget();
    const track = Object.assign(new EventTarget(), {
        readyState: "live",
        stop() {
            this.readyState = "ended";
        },
    });
    const stream = { getTracks: () => [track] };
    const source = new AudioNode();
    const destination = {};
    const audio = Object.assign(new EventTarget(), {
        sampleRate: 16000,
        currentTime: 0,
        state: "running",
        createOscillator: () =>
            Object.assign(new AudioNode(), {
                frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
                onended: null as (() => void) | null,
                start() {},
                stop() {
                    queueMicrotask(() => this.onended?.());
                },
            }),
        createGain: () =>
            Object.assign(new AudioNode(), {
                gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
            }),
        destination,
        audioWorklet: { addModule: async () => {} },
        resume: async () => {},
        close: async () => {
            audio.state = "closed";
        },
        createMediaStreamSource: () => source,
    });
    const worker = Object.assign(new Port(), {
        terminated: false,
        terminate() {
            this.terminated = true;
        },
    });
    const capture = Object.assign(new AudioNode(), { port: new Port() });
    const speech = Object.assign(new EventTarget(), {
        getVoices: () => [
            { voiceURI: "local-en", lang: "en-US", localService: true, default: true },
        ],
        speak: () => {},
        cancel: () => {},
    });
    const globals: Record<string, unknown> = {
        victorListening: env,
        document: page,
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window),
        isSecureContext: true,
        navigator: { mediaDevices: { getUserMedia: async () => stream } },
        AudioContext: function () {
            return audio;
        },
        AudioWorkletNode: function () {
            return capture;
        },
        Worker: function () {
            return worker;
        },
        speechSynthesis: speech,
        SpeechSynthesisUtterance: function () {},
    };
    const originals = Object.keys(globals).map(
        (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );

    for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }

    t.after(async () => {
        victorMode.disable();
        await settle();

        for (const [key, descriptor] of originals) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    return {
        ...env,
        page,
        track,
        audio,
        source,
        worker,
        capture,
        preserved,
        async listen() {
            victorMode.enable({
                conversationId: "session",
                preserveDraft: (text) => preserved.push(text),
            });
            assert.equal(victorMode.state.phase, "preparing");
            assert.deepEqual(worker.messages, [{ type: "init" }]);
            worker.emit({ type: "ready" });
            await settle();
            assert.equal(victorMode.state.phase, "listening");
            assert.equal(source.target, capture, "microphone connects to capture");
            assert.equal(capture.target, destination);
            const start = worker.messages.find((message) => message.type === "start");

            assert.ok(start?.turn, "recognition starts before capture");

            return start.turn;
        },
        async assertStopped() {
            await settle();
            assert.equal(track.readyState, "ended");
            assert.equal(source.target, null);
            assert.equal(capture.target, null);
            assert.equal(capture.port.closed, true);
            assert.equal(worker.terminated, true);
            assert.equal(audio.state, "closed");
            assert.deepEqual(env.submissions, []);
        },
    };
}

test("Victor listens beyond one minute and through silence until send it submits once", async (t) => {
    const h = harness(t);
    const turn = await h.listen();

    h.worker.emit({ type: "partial", turn, text: "Keep listening" });
    assert.equal(victorMode.state.text, "Keep listening");

    // Advance only while listening: ready cleared preparation timers; no reply starts speech timers.
    for (const elapsed of [59_999, 2, 5 * 60_000]) {
        t.mock.timers.tick(elapsed);
        await settle();
        assert.equal(victorMode.state.phase, "listening", "silence must not end listening");
        assert.equal(victorMode.state.text, "Keep listening");
        assert.equal(h.track.readyState, "live");
        assert.equal(h.source.target, h.capture);
        assert.equal(h.worker.terminated, false);
        assert.deepEqual(h.submissions, [], "silence never submits");
    }

    h.worker.emit({ type: "partial", turn, text: "Keep listening send it" });
    assert.equal(victorMode.state.phase, "submitting");
    assert.equal(h.capture.port.messages.at(-1)?.type, "flush");
    h.capture.port.emit({ type: "flushed" });
    assert.equal(h.track.readyState, "ended");
    assert.equal(h.source.target, null);
    assert.equal(h.capture.port.closed, true);
    assert.equal(h.worker.messages.filter((message) => message.type === "finish").length, 1);
    assert.deepEqual(h.submissions, [], "wait for the finalized transcript before sending");

    const final = { type: "final", turn, text: "Keep listening send it" };

    h.worker.emit(final);
    h.worker.emit(final);
    await settle();
    h.worker.emit(final);
    assert.equal(victorMode.state.phase, "waiting");
    assert.deepEqual(h.submissions, [
        {
            path: "c/session/submit",
            body: {
                text: "Keep listening",
                requestId: "victor-request",
                mode: "followUp",
                inputSource: "victor",
                attachments: [],
                inlineFiles: false,
            },
        },
    ]);
    victorMode.disable();
    assert.deepEqual(h.preserved, [], "a sent message is not restored as an unsent draft");
});

for (const reason of [
    "Victor off",
    "hidden",
    "conversation changed",
    "driver changed",
    "overload",
]) {
    test(`${reason} still stops capture and keeps the unsent draft`, async (t) => {
        const h = harness(t);
        const turn = await h.listen();

        h.worker.emit({ type: "partial", turn, text: "Unsent words" });

        switch (reason) {
            case "Victor off":
                victorMode.disable();
                break;
            case "hidden":
                h.page.hidden = true;
                h.page.dispatchEvent(new Event("visibilitychange"));
                break;
            case "conversation changed":
                h.state.conversationId = "another-session";
                h.listeners.forEach((listener) => listener());
                break;
            case "driver changed":
                h.state.view.turns.driver = "another-person";
                h.listeners.forEach((listener) => listener());
                break;
            case "overload":
                h.capture.port.emit({ type: "samples", samples: new Float32Array(32_001) });
                assert.equal(victorMode.state.phase, "error");
                assert.match(victorMode.state.message, /cannot keep up/);
                await h.assertStopped();
                victorMode.disable();
                break;
        }

        assert.equal(victorMode.state.phase, "off");
        assert.deepEqual(h.preserved, ["Unsent words"]);
        await h.assertStopped();
        t.mock.timers.tick(5 * 60_000);
        await settle();
        assert.equal(victorMode.state.phase, "off", "cancelled timers cannot restart Victor");
        await h.assertStopped();
    });
}
