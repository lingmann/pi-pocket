// The real adapter with storage and controller stand-ins; browser tests cover the actual Composer.
import assert from "node:assert/strict";
import { test } from "node:test";

type Handoff = {
    conversationId: string;
    initialText: string;
    validateText?: (text: string) => string | null;
    consumeDraft: () => void;
    preserveDraft: (text: string) => void;
};
type Toggle = {
    conversationId: string;
    sending: boolean;
    hasAttachments: boolean;
    takeDraft: () => { text: string; initialText: string };
    validateText?: Handoff["validateText"];
};
type Dependencies = {
    mode: {
        active: boolean;
        unavailable: (id: string) => string | null;
        enable: (options: Handoff) => void;
        disable: () => void;
    };
    notify: (level: string, message: string) => void;
    readDraft: (id: string) => string;
    expandDraft: (id: string, text: string) => string;
    writeDraft: (id: string, value: string) => void;
};
const { createVictorComposer } = (await import(
    new URL("../web/victor-composer.js", import.meta.url).href
)) as {
    createVictorComposer: (dependencies: Dependencies) => {
        mount: (id: string, changed: (text: string) => void) => () => void;
        toggle: (options: Toggle) => void;
    };
};

function setup() {
    const saved = new Map([["first", "Typed"]]);
    const pastes = new Map<string, string>();
    const notices: string[] = [];
    const calls: string[] = [];
    let enabled: Handoff | null = null;
    let unavailable: string | null = null;
    let writeError = false;
    const mode = {
        active: false,
        unavailable: () => unavailable,
        enable(options: Handoff) {
            calls.push("enable");
            enabled = options;
            this.active = true;
        },
        disable() {
            calls.push("disable");
            this.active = false;
            // Model the controller's synchronous return of its current unsent text.
            enabled?.preserveDraft(enabled.initialText);
        },
    };
    const adapter = createVictorComposer({
        mode,
        notify: (_level, message) => notices.push(message),
        readDraft: (id) => saved.get(id) ?? "",
        expandDraft: (id, text) => text.replace("<paste>", pastes.get(id) ?? "<paste>"),
        writeDraft(id, value) {
            if (writeError) {
                throw new Error("storage unavailable");
            }

            saved.set(id, value);
            pastes.delete(id);
        },
    });
    const toggle = (options: Partial<Toggle> = {}) =>
        adapter.toggle({
            conversationId: "first",
            sending: false,
            hasAttachments: false,
            takeDraft() {
                calls.push("takeDraft");
                const text = saved.get("first") ?? "";

                return { text, initialText: text.replace("<paste>", pastes.get("first") ?? "") };
            },
            ...options,
        });

    return {
        adapter,
        mode,
        saved,
        pastes,
        notices,
        calls,
        toggle,
        handoff() {
            assert.ok(enabled);

            return enabled;
        },
        block(reason: string) {
            unavailable = reason;
        },
        failWrites() {
            writeError = true;
        },
    };
}

for (const guard of ["controller", "sending", "attachments"]) {
    test(`${guard} guard runs before taking the draft or enabling audio`, () => {
        const h = setup();

        if (guard === "controller") {
            h.block("not available");
        }

        h.toggle({ sending: guard === "sending", hasAttachments: guard === "attachments" });
        assert.deepEqual(h.calls, []);
        assert.equal(h.notices.length, 1);
        assert.equal(h.saved.get("first"), "Typed");
    });
}

test("activation snapshots synchronously, delegates validation, and consumes before notifying", () => {
    const h = setup();
    const validateText = () => "validation belongs to the composer";
    const changes: string[] = [];

    h.saved.set("first", "<paste>");
    h.pastes.set("first", "Expanded");
    h.adapter.mount("first", (text) => {
        assert.equal(h.saved.get("first"), text);
        assert.equal(h.pastes.has("first"), false);
        changes.push(text);
    });
    h.toggle({ validateText });
    assert.deepEqual(h.calls, ["takeDraft", "enable"]);
    assert.equal(h.handoff().initialText, "Expanded");
    assert.equal(h.handoff().validateText, validateText);
    assert.equal(h.saved.get("first"), "<paste>");
    h.handoff().consumeDraft();
    assert.deepEqual(changes, [""]);
});

test("restoration replaces its predecessor without trimming or duplication", () => {
    const h = setup();
    const draft = "  Typed spoken\n\n";

    h.toggle();
    h.handoff().preserveDraft(draft);
    h.handoff().preserveDraft(draft);
    assert.equal(h.saved.get("first"), draft);
    h.handoff().consumeDraft();
    h.handoff().preserveDraft(draft);
    assert.equal(h.saved.get("first"), draft);
});

test("changed storage refuses consumption and restoration keeps newer expanded text", () => {
    const h = setup();

    h.toggle();
    h.saved.set("first", "New <paste>");
    h.pastes.set("first", "content");
    assert.throws(() => h.handoff().consumeDraft(), /draft changed/);
    h.handoff().preserveDraft("Typed spoken");
    assert.equal(h.saved.get("first"), "New content\n\nTyped spoken");
    assert.equal(h.pastes.has("first"), false);
});

test("unmount returns an unsent draft to storage without notifying the old composer", () => {
    const h = setup();
    const changes: string[] = [];
    const unmount = h.adapter.mount("first", (text) => changes.push(text));

    h.toggle();
    h.handoff().initialText = "Typed spoken";
    unmount();
    assert.equal(h.mode.active, false);
    assert.equal(h.saved.get("first"), "Typed spoken");
    assert.deepEqual(changes, []);
});

test("a late rejection reaches only the remounted origin and preserves newer typing", () => {
    const h = setup();
    const oldChanges: string[] = [];
    const otherChanges: string[] = [];
    const newChanges: string[] = [];
    const unmount = h.adapter.mount("first", (text) => oldChanges.push(text));

    h.toggle();
    const attempt = h.handoff();

    attempt.consumeDraft();
    h.mode.active = false; // The controller stopped after consumption; no unsent text to return.
    unmount();
    const unmountOther = h.adapter.mount("second", (text) => otherChanges.push(text));

    h.adapter.mount("first", (text) => newChanges.push(text));
    h.saved.set("first", "New typing");
    attempt.preserveDraft("Typed spoken");
    assert.deepEqual(oldChanges, [""]);
    assert.deepEqual(otherChanges, []);
    assert.deepEqual(newChanges, ["New typing\n\nTyped spoken"]);
    h.toggle();
    unmountOther();
    assert.equal(h.mode.active, true, "another composer's cleanup does not stop the owner");
});

test("turning off does not take another snapshot, even with activation guards set", () => {
    const h = setup();

    h.toggle();
    h.block("not available");
    h.toggle({ sending: true, hasAttachments: true });
    assert.deepEqual(h.calls, ["takeDraft", "enable", "disable"]);
    assert.equal(h.mode.active, false);
});

test("failed writes propagate without notifying UI or advancing draft ownership", () => {
    const h = setup();
    const changes: string[] = [];

    h.adapter.mount("first", (text) => changes.push(text));
    h.toggle();
    h.failWrites();
    assert.throws(() => h.handoff().consumeDraft(), /storage unavailable/);
    assert.throws(() => h.handoff().preserveDraft("Recovered"), /storage unavailable/);
    assert.equal(h.saved.get("first"), "Typed");
    assert.deepEqual(changes, []);
});
