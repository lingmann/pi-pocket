// Browser-local, half-duplex Victor. Only finalized text goes to Pi; audio never leaves this tab.
import DOMPurify from "dompurify";
import { marked } from "marked";
import { waitForWorkerControl } from "./service-worker.js";
import { api, notify, store, uid } from "./store.js";
import { replyText } from "./ui.js";
import { setDictationBlocked } from "./voice.js";

const SEND = /(?:^|\s)send\s+it[\s.!?,;:]*$/i;
const SPEEDS = [0.75, 1, 1.25, 1.5];
const SPEED_KEY = "pocket.victor.speed";
const listeners = new Set();
let epoch = 0;
let turn = 0;
let owner = null;
let worker = null;
let runtimeReady = false;
let speechId = 0;
let activeSpeech = null;
let playback = null;
let context = null;
let cueDone = null;
let microphone = null;
let source = null;
let capture = null;
let captureId = 0;
let flushing = false;
let queuedSamples = 0;
let sampleRate = 0;
let pending = null;
// Unlike audio ownership, an unresolved POST survives turning Victor off.
let delivery = null;
let startingText = "";
let recognizedText = "";
let lastReply = null;
let unsent = false;
let unsubscribe = null;
const timers = new Map();

export const victorMode = {
    state: {
        phase: "off",
        text: "",
        message: "",
        hasReply: false,
        speed: savedSpeed(),
        deliveryPending: false,
    },
    get active() {
        return this.state.phase !== "off";
    },
    // Audio activation is tab-wide; a pending POST protects only its originating draft.
    blocksSend(conversationId) {
        return delivery !== null && delivery.id === conversationId;
    },
    subscribe(listener) {
        listeners.add(listener);

        return () => listeners.delete(listener);
    },
    enable,
    disable,
    unavailable,
    readReply,
    setSpeed(value) {
        const speed = validSpeed(value);

        try {
            localStorage.setItem(SPEED_KEY, String(speed));
        } catch {
            // Private browsing or full storage must not prevent speech.
        }

        update({ speed });
    },
};

function validSpeed(value) {
    const speed = typeof value === "string" ? Number(value) : value;

    return SPEEDS.includes(speed) ? speed : 1.25;
}

function savedSpeed() {
    try {
        return validSpeed(localStorage.getItem(SPEED_KEY));
    } catch {
        return 1.25;
    }
}

function update(patch) {
    victorMode.state = {
        ...victorMode.state,
        ...patch,
        hasReply: lastReply !== null,
        deliveryPending: delivery !== null,
    };

    for (const listener of listeners) {
        listener(victorMode.state);
    }
}

function timer(name, ms, action) {
    clearTimer(name);
    timers.set(name, setTimeout(action, ms));
}

function clearTimer(name) {
    clearTimeout(timers.get(name));
    timers.delete(name);
}

function permissionKey() {
    const { me, view } = store.state;

    return JSON.stringify([me?.id, me?.role, me?.sessions, view.turns?.on, view.turns?.driver]);
}

/** Shared with the composer and rechecked before capture and sending; null means eligible. The server enforces rights too. */
function unavailable(id, idle = true) {
    const { me, view, connection, conversationId } = store.state;

    if (connection !== "open" || conversationId !== id || view.conversation?.id !== id) {
        return "Wait for this conversation to connect.";
    }

    if (view.conversation.kind !== "session" || view.conversation.pip) {
        return "Victor mode is available in the main session only.";
    }

    if (!me || me.role === "viewer" || (view.turns?.on && view.turns.driver !== me.id)) {
        return "You need permission to send, and the wheel when taking turns.";
    }

    if (!view.agent?.model) {
        return "Pick a model before turning Victor on.";
    }

    if (idle && delivery) {
        return "Wait until your Victor message is sent before turning Victor on.";
    }

    if (idle && (view.live.busy || view.inbox.length > 0)) {
        return "Wait for Pi and the message queue to finish first.";
    }

    return null;
}

function textUnavailable(text, validateText) {
    return /^[!/]/.test(text.trimStart())
        ? "Victor sends ordinary text only. Send or clear commands before turning Victor on."
        : (validateText?.(text) ?? null);
}

/** Recognition may revise its whole transcript, but never the text handed over by the composer. */
function combinedText() {
    const separator = startingText && recognizedText && !/\s$/.test(startingText) ? " " : "";

    return startingText + separator + recognizedText;
}

/**
 * Draft handoff from the composer adapter:
 * - initialText is expanded plain text, kept separate from revisable recognition.
 * - validateText runs synchronously on activation and on the final combined text.
 * - consumeDraft synchronously clears the handed-off copy before each POST; throwing prevents it.
 * - preserveDraft receives expanded, untrimmed text on stop or definite late rejection. It may run
 *   after the originating composer unmounts and must retain newer typing in that conversation.
 * Uncertain delivery never invokes preservation for the submitted text. An unresolved POST blocks
 * all reactivation, but blocks ordinary Send only in its own conversation (blocksSend).
 */
function enable({ conversationId, initialText = "", preserveDraft, consumeDraft, validateText }) {
    if (victorMode.active) {
        return;
    }

    const reason = unavailable(conversationId) ?? textUnavailable(initialText, validateText);

    if (reason) {
        notify("warning", reason);

        return;
    }

    if (
        !isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        !globalThis.AudioWorkletNode ||
        !globalThis.AudioContext
    ) {
        notify(
            "warning",
            "Victor needs HTTPS (or localhost), microphone access, AudioWorklet and Web Audio.",
        );

        return;
    }

    const token = ++epoch;

    owner = {
        id: conversationId,
        preserveDraft,
        consumeDraft,
        validateText,
        boundary: store.state.view.order.at(-1) ?? null,
        streamId: store.state.streamId,
        permission: permissionKey(),
    };
    startingText = initialText;
    recognizedText = "";
    unsent = true;
    setDictationBlocked(true);
    update({
        phase: "preparing",
        text: initialText,
        message: "Loading local recognition and speech…",
    });
    unsubscribe = store.subscribe(reconcile);
    document.addEventListener("visibilitychange", hidden);
    addEventListener("pagehide", leave);

    try {
        timer("prepare", 180000, () =>
            fail("Speech assets took too long to load. Turn Victor off and on to retry."),
        );
        // Activate audio on the Victor tap, before loading the engines. Reuse it across turns.
        const audio = new AudioContext();

        context = audio;
        sampleRate = audio.sampleRate;
        audio.addEventListener("statechange", () => {
            if (token === epoch && (capture || activeSpeech) && audio.state !== "running") {
                fail("Audio was interrupted. Your draft has been kept.");
            }
        });
        void audio.resume().catch((error) => token === epoch && fail(error.message));

        try {
            void navigator.storage?.persist?.().catch(() => {});
        } catch {
            // Persistence is best effort, including browsers that throw instead of rejecting.
        }

        const controlling = waitForWorkerControl();

        if (controlling) {
            void controlling.then(
                () => startWorker(token),
                () => startWorker(token),
            );
        } else {
            startWorker(token);
        }
    } catch (error) {
        fail(error.message);
    }
}

function startWorker(token) {
    // Victor may have been turned off or lost ownership during first installation.
    if (token !== epoch) {
        return;
    }

    try {
        worker = new Worker("/victor-worker.js");

        worker.onmessage = ({ data }) => {
            if (token === epoch) {
                hear(data);
            }
        };

        worker.onerror = () =>
            token === epoch &&
            fail(
                "The speech worker failed. Check that victor assets are prepared, then turn Victor off and on.",
            );
        worker.onmessageerror = () =>
            token === epoch && fail("The speech worker returned an unreadable message.");
        worker.postMessage({ type: "init" });
    } catch (error) {
        fail(error.message);
    }
}

/** Keep cues outside the capture graph; a bounded fallback also handles interrupted audio. */
function recordingCue(audio, starting) {
    if (audio.state !== "running") {
        return Promise.resolve();
    }

    cueDone = new Promise((resolve) => {
        let tone;
        let gain;

        const done = () => {
            clearTimeout(timeout);
            tone?.disconnect();
            gain?.disconnect();
            resolve();
        };

        const timeout = setTimeout(done, 500);

        try {
            tone = audio.createOscillator();
            gain = audio.createGain();
            const now = audio.currentTime;

            tone.frequency.setValueAtTime(starting ? 660 : 440, now);
            tone.frequency.exponentialRampToValueAtTime(starting ? 990 : 330, now + 0.12);
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
            gain.gain.linearRampToValueAtTime(0, now + 0.12);
            tone.connect(gain);
            gain.connect(audio.destination);
            tone.onended = done;
            tone.start();
            tone.stop(now + 0.14);
        } catch {
            // A notification must not prevent capture or teardown if audio is unavailable.
            done();
        }
    });

    return cueDone;
}

function stopCapture() {
    const wasRecording = source !== null;

    captureId++;
    flushing = false;
    source?.disconnect();
    source = null;
    capture?.port.postMessage({ type: "stop" });
    capture?.disconnect();
    capture?.port.close();
    capture = null;
    const stream = microphone;

    microphone = null;
    stream?.getTracks().forEach((track) => track.stop());

    if (wasRecording) {
        void recordingCue(context, false);
    }
}

/** Invalidate callbacks before cancelling speech or stopping tracks: both can dispatch more events. */
function release() {
    epoch++;
    unsubscribe?.();
    unsubscribe = null;
    document.removeEventListener("visibilitychange", hidden);
    removeEventListener("pagehide", leave);

    for (const name of timers.keys()) {
        clearTimer(name);
    }

    stopSpeech();
    stopCapture();
    const audio = context;
    const close = () => void audio?.close().catch(() => {});

    if (cueDone) {
        void cueDone.then(close);
    } else {
        close();
    }

    context = null;
    cueDone = null;
    worker?.terminate();
    worker = null;
    runtimeReady = false;
    queuedSamples = 0;
    pending = null;
    lastReply = null;
}

function disable() {
    const draft = unsent ? victorMode.state.text : "";
    const preserve = owner?.preserveDraft;

    release();
    owner = null;
    unsent = false;
    startingText = "";
    recognizedText = "";
    setDictationBlocked(false);
    update({ phase: "off", text: "", message: "" });

    if (draft) {
        preserve?.(draft);
    }
}

function fail(message) {
    release();
    update({
        phase: "error",
        message: `${message} Turn Victor off to return to typing.`,
    });
}

function leave() {
    if (victorMode.active) {
        disable();
    }
}

function hidden() {
    if (document.hidden) {
        leave();
    }
}

function stopForChange(message) {
    disable();
    notify("warning", message);
}

/** Replaying a reply pauses capture without discarding the current recognition stream or draft. */
function listen(resume = false) {
    const reason = unavailable(owner.id);

    if (reason) {
        fail(reason);

        return;
    }

    const token = epoch;
    const currentTurn = resume ? turn : ++turn;
    const id = ++captureId;
    const audio = context;

    queuedSamples = 0;
    unsent = true;
    update({ phase: "listening", message: "Opening microphone…" });

    try {
        if (!resume) {
            worker.postMessage({ type: "start", turn: currentTurn, sampleRate });
        }

        const resumed = audio.resume();
        const acquired = navigator.mediaDevices
            .getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false })
            .then((stream) => {
                if (token !== epoch || id !== captureId) {
                    stream.getTracks().forEach((track) => track.stop());

                    return null;
                }

                microphone = stream;
                stream.getTracks().forEach((track) =>
                    track.addEventListener("ended", () => {
                        if (token === epoch && microphone === stream) {
                            fail("Microphone capture ended. Your draft has been kept.");
                        }
                    }),
                );

                return stream;
            });

        void openCapture(audio, resumed, acquired, token, currentTurn, id);
    } catch (error) {
        fail(error.message);
    }
}

async function openCapture(audio, resumed, acquired, token, currentTurn, id) {
    try {
        const [, stream] = await Promise.all([
            resumed,
            acquired,
            audio.audioWorklet.addModule("/victor-capture-worklet.js"),
        ]);

        if (token !== epoch || id !== captureId || !stream) {
            return;
        }

        // A command-only turn can reopen capture while its stop cue is still playing.
        await cueDone;

        if (token !== epoch || id !== captureId) {
            return;
        }

        await recordingCue(audio, true);

        if (token !== epoch || id !== captureId) {
            return;
        }

        if (audio.state !== "running") {
            throw new Error("Audio was interrupted");
        }

        capture = new AudioWorkletNode(audio, "pocket-victor-capture");

        capture.port.onmessage = ({ data }) => {
            if (id !== captureId || (victorMode.state.phase !== "listening" && !flushing)) {
                return;
            }

            if (data.type === "flushed") {
                stopCapture();
                worker.postMessage({ type: "finish", turn: currentTurn });

                return;
            }

            if (data.type === "error" || data.type === "overload") {
                fail(data.message);

                return;
            }

            const samples = data.samples;

            if (!(samples instanceof Float32Array)) {
                return;
            }

            queuedSamples += samples.length;

            if (queuedSamples > sampleRate * 2) {
                fail("Recognition cannot keep up with the microphone. Your draft has been kept.");

                return;
            }

            worker.postMessage({ type: "audio", turn: currentTurn, samples }, [samples.buffer]);
        };

        source = audio.createMediaStreamSource(stream);
        source.connect(capture);
        capture.connect(audio.destination);
        update({ message: "Listening. Say “send it” to submit; silence does not send." });
        submitCommand();
    } catch (error) {
        if (token === epoch && id === captureId) {
            fail(`Microphone could not start: ${error.message}`);
        }
    }
}

function hear(data) {
    // A fatal error belongs to the shared runtime, even if its ASR turn has already ended.
    if (data.type !== "error" && data.turn !== undefined && data.turn !== turn) {
        return;
    }

    switch (data.type) {
        case "ready":
            if (!runtimeReady && victorMode.state.phase === "preparing") {
                runtimeReady = true;
                clearTimer("prepare");
                listen();
            }

            break;
        case "synthesized":
            playReply(data);
            break;
        case "synthesis-error":
            if (currentSpeech(data.speechId)?.stage === "generating") {
                completeSpeech(
                    activeSpeech,
                    `Speech failed: ${data.message}. Tap Read reply to retry.`,
                );
            }

            break;
        case "progress":
            update({ message: data.message });
            break;
        case "error":
            fail(data.message);
            break;
        case "ack":
            queuedSamples = Math.max(0, queuedSamples - data.samples);
            capture?.port.postMessage({ type: "ack", samples: data.samples });
            break;
        case "partial":
            if (unsent) {
                recognizedText = data.text;
                update({ text: combinedText() });
                submitCommand();
            }

            break;
        case "final":
            if (victorMode.state.phase === "submitting" && !pending) {
                clearTimer("finish");
                void submitFinal(data.text);
            }

            break;
    }
}

function submitCommand() {
    if (victorMode.state.phase === "listening" && capture && SEND.test(recognizedText)) {
        update({ phase: "submitting", message: "Finishing recognition…" });
        flushing = true;
        timer("finish", 15000, () => fail("Recognition did not finish. Your draft has been kept."));
        capture.port.postMessage({ type: "flush" });
    }
}

async function submitFinal(transcript) {
    if (!SEND.test(transcript)) {
        recognizedText = transcript;
        update({ text: combinedText() });
        fail("The final transcript did not end with “send it”. Your draft has been kept.");

        return;
    }

    recognizedText = transcript.replace(SEND, "").trim();
    const draft = combinedText();
    const text = draft.trim();

    update({ text: draft });

    if (!text) {
        recognizedText = "";
        listen();

        return;
    }

    const reason = unavailable(owner.id) ?? textUnavailable(text, owner.validateText);

    if (reason) {
        fail(reason);

        return;
    }

    try {
        // Clear only the handed-off composer draft, before delivery can become uncertain.
        owner.consumeDraft?.();
    } catch (error) {
        fail(`The draft could not be handed over: ${error.message}. Nothing was sent.`);

        return;
    }

    const token = epoch;
    const preserve = owner.preserveDraft;
    const attempt = { id: owner.id, requestId: uid(), text, accepted: false, spoken: false };

    delivery = attempt;
    pending = attempt;
    lastReply = null;
    // Once the POST starts, delivery may be uncertain. Never restore an automatic duplicate draft.
    unsent = false;
    update({ message: "Sending to Pi…" });

    try {
        const result = await api(`c/${attempt.id}/submit`, {
            text,
            requestId: attempt.requestId,
            source: "victor",
            mode: "followUp",
            attachments: [],
            inlineFiles: false,
        });

        delivery = null;

        if (token !== epoch) {
            update({});

            return;
        }

        // The server can redact hidden values. Use its prepared text, but still require an exact
        // transcript match and our author attribution. A different stored message still fails closed.
        if (typeof result?.acceptedText === "string") {
            attempt.text = result.acceptedText;
        }

        startingText = "";
        recognizedText = "";
        attempt.accepted = true;
        update({ phase: "waiting", text: "", message: "Waiting for Pi’s completed reply…" });
        timer("reply", 30000, checkReply);
        reconcile();
    } catch (error) {
        delivery = null;
        const rejected = error.status >= 400 && error.status < 500;
        const message = rejected
            ? `Pi did not accept the message: ${error.message}`
            : "Delivery is uncertain. Check the conversation before sending this text again.";

        if (token !== epoch) {
            // Navigation or audio failure may have released the controller while the POST ran.
            // Restore only definite rejections, using the captured conversation's draft handoff.
            let restorationError = "";

            try {
                if (rejected) {
                    preserve?.(draft);
                }
            } catch (error) {
                restorationError = ` The draft could not be restored: ${error.message}`;
            } finally {
                // A full or unavailable browser store must not leave ordinary Send blocked.
                update({});
            }

            notify("warning", message + restorationError);

            return;
        }

        unsent = rejected;
        fail(message);
    }
}

/** Read only the exchange after our boundary. Ambiguous ownership disables Victor rather than guessing. */
function reconcile() {
    if (!owner) {
        return;
    }

    const state = store.state;
    const reason = unavailable(owner.id, false);

    if (reason || state.streamId !== owner.streamId || permissionKey() !== owner.permission) {
        stopForChange(
            "Victor stopped because the conversation, connection or permissions changed.",
        );

        return;
    }

    const { view } = state;
    const boundary = owner.boundary === null ? -1 : view.order.indexOf(owner.boundary);

    if (owner.boundary !== null && boundary < 0) {
        stopForChange("Victor stopped because the conversation history changed.");

        return;
    }

    const added = view.order
        .slice(boundary + 1)
        .map((id) => view.entries.get(id))
        .filter(Boolean);
    const users = added.filter((entry) => entry.kind === "user");

    if (!pending) {
        if (users.length || view.live.busy || view.inbox.length) {
            stopForChange(
                "Victor stopped because another exchange started. Turn it on again when Pi is idle.",
            );
        }

        return;
    }

    if (
        users.length > 1 ||
        users.some(
            (entry) =>
                (pending.accepted && entry.text.trim() !== pending.text) ||
                (view.authors[entry.id] !== undefined && view.authors[entry.id] !== state.me.id),
        ) ||
        added.some((entry) => entry.kind === "reset")
    ) {
        stopForChange("Victor stopped because this reply could belong to another message.");

        return;
    }

    if (
        !pending.accepted ||
        pending.spoken ||
        users.length !== 1 ||
        view.live.busy ||
        view.inbox.length
    ) {
        return;
    }

    // Attribution may arrive after the entry. Missing attribution is not proof that it is ours.
    if (view.authors[users[0].id] !== state.me.id) {
        return;
    }

    const answer = added.findLast((entry) => entry.kind === "assistant" && entry.id > users[0].id);

    if (!answer) {
        return;
    }

    pending.spoken = true;
    clearTimer("reply");
    const text = speechText(replyText(answer));

    if (answer.error || !["stop", "length"].includes(answer.stopReason) || !text) {
        finishReply("Pi finished without a speakable answer. See the conversation.");

        return;
    }

    lastReply = text;
    speakReply();
}

function speechText(markdown) {
    const fragment = DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: [
            "p",
            "br",
            "ul",
            "ol",
            "li",
            "strong",
            "em",
            "del",
            "code",
            "blockquote",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "a",
            "table",
            "tr",
            "td",
            "th",
        ],
        ALLOWED_ATTR: [],
        FORBID_CONTENTS: ["pre", "script", "style", "iframe"],
    });

    for (const node of fragment.querySelectorAll(
        "p, br, li, blockquote, h1, h2, h3, h4, h5, h6, tr, td, th",
    )) {
        node.append(document.createTextNode("\n"));
    }

    return fragment.textContent
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n/g, "\n")
        .trim();
}

function checkReply() {
    if (!pending) {
        return;
    }

    if (store.state.view.live.busy) {
        timer("reply", 30000, checkReply);
    } else {
        finishReply(
            "No completed, attributable reply arrived. See the conversation; nothing was replayed.",
        );
    }
}

function finishReply(message, resume = false) {
    clearTimer("reply");
    stopSpeech();

    if (pending) {
        pending = null;
        owner.boundary = store.state.view.order.at(-1) ?? null;
    }

    if (message) {
        notify("warning", message);
    }

    listen(resume);
}

/** Clear ownership before stopping: a queued ended event must never reopen the microphone. */
function stopSpeech() {
    activeSpeech = null;
    clearTimer("synthesis");
    clearTimer("playback");
    const node = playback;

    playback = null;

    if (node) {
        node.onended = null;

        try {
            node.stop();
        } catch {
            // A source that failed to start may already be stopped.
        }

        node.disconnect();
        node.buffer = null;
    }
}

function currentSpeech(id) {
    return activeSpeech?.id === id && activeSpeech.token === epoch ? activeSpeech : null;
}

function completeSpeech(request, message = null) {
    if (!request || currentSpeech(request.id) !== request) {
        return;
    }

    const resume = request.resume;

    stopSpeech();

    if (!runtimeReady || !worker || context?.state !== "running") {
        fail("Local speech is no longer available. Turn Victor off and on to retry.");

        return;
    }

    finishReply(message, resume);
}

function speakReply() {
    if (!runtimeReady || !lastReply || !owner) {
        return;
    }

    const request = {
        id: ++speechId,
        token: epoch,
        resume: victorMode.state.phase === "listening",
        stage: "generating",
    };
    const speed = validSpeed(victorMode.state.speed);

    stopCapture();
    stopSpeech();
    activeSpeech = request;
    update({ phase: "speaking", message: "Preparing speech…" });
    // Allow slower devices and long answers, but never leave synchronous WASM blocked forever.
    const deadline = Math.min(180000, Math.max(30000, (lastReply.length * 120) / speed));

    timer("synthesis", deadline, () => {
        if (currentSpeech(request.id) === request) {
            fail("Speech generation took too long. Turn Victor off and on to retry.");
        }
    });

    try {
        worker.postMessage({ type: "synthesize", speechId: request.id, text: lastReply, speed });
    } catch (error) {
        fail(`The speech worker is unavailable: ${error.message}`);
    }
}

function playReply({ speechId: id, samples, sampleRate: rate }) {
    const request = currentSpeech(id);

    if (!request || request.stage !== "generating") {
        return;
    }

    clearTimer("synthesis");

    if (context?.state !== "running") {
        fail("Audio playback was interrupted. Turn Victor off and on to retry.");

        return;
    }

    try {
        if (
            !(samples instanceof Float32Array) ||
            !samples.length ||
            !samples.every(Number.isFinite) ||
            !samples.some((sample) => sample !== 0) ||
            rate !== 24000
        ) {
            throw new Error("The speech engine returned invalid audio");
        }

        // Use the generated rate, not the microphone rate. Model speed does not shift pitch.
        const buffer = context.createBuffer(1, samples.length, rate);
        const node = context.createBufferSource();

        buffer.copyToChannel(samples, 0);
        playback = node;
        node.buffer = buffer;
        node.connect(context.destination);
        request.stage = "playing";
        node.onended = () => completeSpeech(request);
        timer("playback", Math.ceil(buffer.duration * 1000) + 10000, () =>
            completeSpeech(request, "Playback stalled. Tap Read reply to retry."),
        );
        node.start();
        update({
            message: "Speaking Pi’s reply. Listening resumes automatically.",
        });
    } catch (error) {
        completeSpeech(request, `Playback failed: ${error.message}. Tap Read reply to retry.`);
    }
}

function readReply() {
    if (victorMode.state.phase === "listening" && lastReply && !unavailable(owner.id)) {
        speakReply();
    }
}
