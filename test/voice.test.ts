// Dictation into a message box (web/voice.js), with a stand-in recognizer: words typed before or beside dictation stay,
// a phrase still being heard finishes where it is when the person types or moves elsewhere, the next one goes where the
// caret is, and Alt+V picks a box that is there, PiP's first.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

/** What voice.js imports, stood in for: hooks for one call outside a component, and no page to draw on. */
const STUBS: Record<string, string> = {
    "preact/hooks": `
        export const useState = (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
        export const useRef = (current) => ({ current });
        export const useEffect = (effect) => globalThis.voiceCleanups.push(effect());
    `,
    "./store.js": `export const notify = () => {};`,
    "./ui.js": `export const html = () => null; export const Icon = () => null;`,
};

registerHooks({
    resolve(specifier, context, next) {
        const stub = STUBS[specifier];

        return stub !== undefined && context.parentURL?.endsWith("/web/voice.js")
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

type Result = { 0: { transcript: string }; isFinal: boolean };
type Recognition = {
    onresult: ((event: { results: Result[] }) => void) | null;
    started: boolean;
};
type Dictation = { listening: boolean; toggle: () => void; stop: (drop?: boolean) => void };
type Voice = {
    useDictation: (
        box: { current: Box | null },
        onText: (value: string, at: number) => void,
        options?: { top?: boolean },
    ) => Dictation;
    toggleDictation: () => boolean;
    setDictationBlocked: (blocked: boolean) => void;
};

const recognitions: Recognition[] = [];

(globalThis as Record<string, unknown>).voiceCleanups = [];
(globalThis as Record<string, unknown>).document = {
    activeElement: null,
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
};
(globalThis as Record<string, unknown>).SpeechRecognition = class {
    onresult = null;
    onerror = null;
    onend = null;
    started = false;

    constructor() {
        recognitions.push(this as unknown as Recognition);
    }

    start() {
        this.started = true;
    }

    stop() {
        this.started = false;
    }

    abort() {
        this.started = false;
    }
};

const voice = (await import(new URL("../web/voice.js", import.meta.url).href)) as Voice;
const page = (globalThis as unknown as { document: { activeElement: unknown } }).document;

/** A textarea as dictation sees it: setting its text puts the caret at the end, as a browser does. */
class Box {
    #value: string;
    selectionStart: number;
    selectionEnd: number;
    isConnected = true;

    constructor(value: string) {
        this.#value = value;
        this.selectionStart = this.selectionEnd = value.length;
    }

    get value() {
        return this.#value;
    }

    set value(value: string) {
        this.#value = value;
        this.selectionStart = this.selectionEnd = value.length;
    }

    setSelectionRange(start: number, end: number) {
        this.selectionStart = start;
        this.selectionEnd = end;
    }

    /** The person types `text` at the caret. */
    type(text: string) {
        const at = this.selectionStart;

        this.value = this.#value.slice(0, at) + text + this.#value.slice(this.selectionEnd);
        this.caret(at + text.length);
    }

    caret(at: number) {
        this.setSelectionRange(at, at);
    }
}

/** Results as the browser sends them: each phrase heard, and whether it is settled. */
const said = (...phrases: [string, boolean][]): { results: Result[] } => ({
    results: phrases.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal })),
});

/** Dictation started in a focused box holding `value`, with the caret at its end. */
function dictate(value = "", options?: { top?: boolean }) {
    const box = new Box(value);

    page.activeElement = box;
    const dictation = voice.useDictation({ current: box }, () => {}, options);

    dictation.toggle();
    const recognition = recognitions.at(-1)!;

    return { box, dictation, hear: (event: { results: Result[] }) => recognition.onresult!(event) };
}

/** The boxes made so far leave the page, as when their component unmounts. */
function unmountAll() {
    const cleanups = (globalThis as unknown as { voiceCleanups: (() => void)[] }).voiceCleanups;

    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
}

test("words heard show as they come, and a revision replaces them", () => {
    const { box, hear } = dictate();

    hear(said(["helo wor", false]));
    assert.equal(box.value, "Helo wor");
    hear(said(["hello world", true]));
    assert.equal(box.value, "Hello world");
    hear(said(["hello world", true], ["again", false]));
    assert.equal(box.value, "Hello world again");
    unmountAll();
});

test("what is typed before the first words are heard stays", () => {
    const { box, hear } = dictate();

    box.type("Fix the bug in");
    hear(said(["now", false]));
    assert.equal(box.value, "Fix the bug in now");
    unmountAll();
});

test("a box cleared before the first words are heard stays cleared", () => {
    const { box, hear } = dictate("Old draft");

    box.value = "";
    box.caret(0);
    hear(said(["new words", false]));
    assert.equal(box.value, "New words");
    unmountAll();
});

test("a phrase still being heard finishes in place around what was typed after it", () => {
    const { box, hear } = dictate();

    hear(said(["please fix the lo", false]));
    assert.equal(box.value, "Please fix the lo");
    box.type("!");
    hear(said(["please fix the login bug", true]));
    assert.equal(box.value, "Please fix the login bug!");
    assert.equal(box.selectionStart, 25, "the caret stays after what was typed");

    // The next phrase goes where the caret is.
    hear(said(["please fix the login bug", true], ["and add a test", false]));
    assert.equal(box.value, "Please fix the login bug! And add a test");
    unmountAll();
});

test("the caret moved mid-phrase: the phrase finishes in place, and the next goes to the caret", () => {
    const { box, hear } = dictate("Intro. Outro.");

    hear(said(["hello wor", false]));
    assert.equal(box.value, "Intro. Outro. Hello wor");
    box.caret(6);
    hear(said(["hello world", false]));
    assert.equal(box.value, "Intro. Outro. Hello world");
    assert.equal(box.selectionStart, 6, "the caret is not pulled back to the words");
    hear(said(["hello world", true]));
    assert.equal(box.value, "Intro. Outro. Hello world");
    assert.equal(box.selectionStart, 6);

    hear(said(["hello world", true], ["more", false]));
    assert.equal(box.value, "Intro. More Outro. Hello world");
    unmountAll();
});

test("text typed before a phrase still being heard moves it along", () => {
    const { box, hear } = dictate("Note:");

    hear(said(["fix the lo", false]));
    assert.equal(box.value, "Note: fix the lo");
    box.caret(0);
    box.type(">> ");
    hear(said(["fix the login", true]));
    assert.equal(box.value, ">> Note: fix the login");
    assert.equal(box.selectionStart, 3);
    unmountAll();
});

test("a letter typed before the words still being heard, the same as theirs, stays before them", () => {
    const { box, hear } = dictate();

    hear(said(["hello", false]));
    box.caret(0);
    box.type("H");
    hear(said(["hello world", false]));
    assert.equal(box.value, "H hello world");
    unmountAll();
});

test("an edit on the words still being heard is kept", () => {
    const { box, hear } = dictate();

    hear(said(["helo wor", false]));
    box.caret(3);
    box.type("l");
    assert.equal(box.value, "Hello wor");
    hear(said(["hello world", false]));
    assert.equal(box.value, "Hello wor");
    unmountAll();
});

test("words go after the text when the box does not have the focus", () => {
    const { box, hear } = dictate("Draft");

    page.activeElement = null;
    hear(said(["more", false]));
    assert.equal(box.value, "Draft more");
    unmountAll();
});

test("Alt+V dictates into PiP's box while it shows, else into the newest box there is", () => {
    const pip = dictate("", { top: true });

    pip.dictation.stop();
    const session = dictate();

    session.dictation.stop();
    const started = recognitions.length;

    assert.equal(voice.toggleDictation(), true);
    assert.equal(recognitions.length, started + 1);
    // PiP's box listens: words heard go there.
    recognitions.at(-1)!.onresult!(said(["for pip", false]));
    assert.equal(pip.box.value, "For pip");
    assert.equal(session.box.value, "");
    pip.dictation.stop();

    // PiP's box gone from the page: the session's takes it.
    pip.box.isConnected = false;
    assert.equal(voice.toggleDictation(), true);
    recognitions.at(-1)!.onresult!(said(["for the session", false]));
    assert.equal(session.box.value, "For the session");
    session.dictation.stop();
    unmountAll();
});

test("Victor blocks existing, PiP, and newly mounted dictation until released", () => {
    const session = dictate("Keep this");
    const recognition = recognitions.at(-1)!;

    voice.setDictationBlocked(true);
    voice.setDictationBlocked(true);
    assert.equal(recognition.started, false);
    assert.equal(recognition.onresult, null, "late results are discarded");
    assert.equal(session.box.value, "Keep this");
    const count = recognitions.length;
    const pip = dictate("PiP draft", { top: true });

    session.dictation.toggle();
    pip.dictation.toggle();
    voice.toggleDictation();
    assert.equal(recognitions.length, count, "neither mounting nor Alt+V bypasses the block");
    voice.setDictationBlocked(false);
    voice.setDictationBlocked(false);
    assert.equal(voice.toggleDictation(), true);
    assert.equal(recognitions.length, count + 1);
    recognitions.at(-1)!.onresult!(said(["restored", true]));
    assert.equal(pip.box.value, "PiP draft restored");
    assert.equal(session.box.value, "Keep this");
    unmountAll();
});

test("Alt+V with no box in the page is not taken", () => {
    voice.useDictation({ current: null }, () => {});
    assert.equal(voice.toggleDictation(), false);
    unmountAll();
});
