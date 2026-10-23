// Real Composer and Victor controller in an isolated app. Only browser speech resources are fake;
// these checks say nothing about recognition accuracy or physical audio routing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { type App, cleanUp, newSession, openApp, owner, root, until, work } from "./helpers.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let first: Awaited<ReturnType<typeof newSession>>;
let second: Awaited<ReturnType<typeof newSession>>;
const run = (script: string) => page.evaluate(`${script}; return "true"`);
const value = async (expression: string) =>
    JSON.parse(await page.evaluate(`return JSON.stringify(${expression})`));
const see = (expression: string) =>
    until(async () => (await value(expression)) === true, expression);
const phase = (name: string) => see(`victor.state.phase === ${JSON.stringify(name)}`);

before(async () => {
    if (!chromium) {
        return;
    }

    writeFileSync(join(work, "victor-draft-fixture.txt"), "File mention fixture");
    const extensions = join(root, "data", "extensions");

    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, "victor-keys.ts"),
        `/** Test composer keys. */
        export default (_host, web) => web.client("victor-keys.js", { access: "view" });
    `,
    );
    writeFileSync(
        join(extensions, "victor-keys.js"),
        `export default pocket => {
        pocket.composerKey({ id: "edit", keys: "Ctrl+W", label: "Edit draft", run(box) {
            window.keyCalls = (window.keyCalls ?? 0) + 1;
            box.set("Shortcut draft");
        } });
        pocket.composerKey({ id: "late", keys: "Ctrl+E", label: "Delayed edit", run(box) {
            return new Promise(resolve => { window.finishKey = () => { box.set("Late draft"); resolve(); }; });
        } });
        window.victorKeysLoaded = true;
    };`,
    );
    app = await openApp(fauxProvider());
    await app.setExtensionEnabled(owner(app), "victor-keys.ts", true);
    first = await newSession(app);
    second = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "victor-composer-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);

    try {
        await see(`(await import('/store.js')).store.state.me?.role === 'owner'`);
    } catch (error) {
        console.log(
            await page.evaluate(
                `return JSON.stringify({ text: document.body.innerText, state: (await import('/store.js')).store.state })`,
            ),
        );

        throw error;
    }
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function fresh() {
    await page.navigate(`${base}/s/${first}`);
    await see(`document.querySelector('.victor-chip') !== null`);
    assert.equal(
        await value(`document.querySelector('.victor-chip').textContent.trim()`),
        "Victor",
    );
    await run(`
        window.pocket = await import('/store.js');
        window.victor = (await import('/victor-mode.js')).victorMode;
        window.audioCreated = 0;
        window.Worker = class {
            constructor() { window.speechWorker = this; }
            postMessage(message) {
                if (message.type === 'start') this.turn = message.turn;
                if (message.type === 'finish') this.onmessage({ data: { type: 'final', turn: this.turn, text: window.finalTranscript } });
            }
            terminate() {}
        };
        window.AudioContext = class {
            constructor() { audioCreated++; this.sampleRate = 48000; this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; }
            addEventListener() {}
            resume() { return Promise.resolve(); }
            close() { return Promise.resolve(); }
            createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        };
        window.AudioWorkletNode = class {
            constructor() {
                window.speechCapture = this;
                this.port = {
                    postMessage: message => {
                        if (message.type === 'flush') queueMicrotask(() => this.port.onmessage({ data: { type: 'flushed' } }));
                    },
                    close() {},
                };
            }
            connect() {}
            disconnect() {}
        };
        navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {}, addEventListener() {} }] });
        pocket.drafts.set(${JSON.stringify(first)}, '');
    `);
    await type("");
}

async function type(text: string) {
    await run(
        `const box = document.querySelector('.composer textarea'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true }))`,
    );
    await see(`document.querySelector('.composer textarea').value === ${JSON.stringify(text)}`);
}

async function paste(text: string) {
    await run(`
        const box = document.querySelector('.composer textarea');
        box.focus();
        const data = new DataTransfer(); data.setData('text/plain', ${JSON.stringify(text)});
        box.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    `);
    await see(`document.querySelector('.composer textarea').value.includes('[Pasted text #')`);
}

async function activate(text = "unfinished speech", audioCount = 1) {
    await run(
        `window.speechWorker = null; window.speechCapture = null; document.querySelector('.victor-chip').click(); window.audioOnTap = audioCreated`,
    );
    await phase("preparing");
    assert.equal(await value("audioOnTap"), audioCount, "audio is created on the original tap");
    await see(`!!window.speechWorker`);
    await run(
        `speechWorker.onmessage({ data: { type: 'ready' } }); speechWorker.onmessage({ data: { type: 'partial', text: ${JSON.stringify(text)} } })`,
    );
    await phase("listening");
    await see(`!!window.speechCapture`);
    assert.equal(
        await value(`document.querySelector('.victor-toggle').textContent.trim()`),
        "Victor",
    );
}

test(
    "production routing serves Victor modules and applies both worker policies",
    real,
    async () => {
        // Generated manifests are tested with isolated output in victor-http.test.ts.
        // This UI fixture must not depend on assets prepared in the serving checkout.
        for (const file of ["victor-worker.js", "victor-capture-worklet.js"]) {
            const worker = await fetch(`${base}/${file}`);

            assert.equal(worker.status, 200, file);
            assert.equal(worker.headers.get("cross-origin-resource-policy"), "same-origin");
            assert.match(worker.headers.get("content-security-policy")!, /worker-src 'none'/);
        }

        for (const file of [
            "victor-mode.js",
            "victor-composer.js",
            "victor-controls.js",
            "victor-cache.js",
            "victor.css",
            "voice.js",
        ]) {
            assert.equal((await fetch(`${base}/${file}`)).status, 200, file);
        }

        const appPage = await fetch(`${base}/`);

        assert.match(await appPage.text(), /@import url\("\/victor\.css"\) layer\(pocket\);/);
    },
);

test("attachments and an outstanding typed submission prevent activation", real, async () => {
    await fresh();
    await run(
        `pocket.insertIntoComposer('', [new File(['contents'], 'draft.txt', { type: 'text/plain' })])`,
    );
    await see(`!!document.querySelector('[aria-label="Remove draft.txt"]')`);
    await run(`document.querySelector('.victor-chip').click()`);
    await phase("off");
    await run(`document.querySelector('[aria-label="Remove draft.txt"]').click()`);
    await type("pending typed message");
    await run(
        `window.originalSubmit = pocket.actions.submit; pocket.actions.submit = () => new Promise(resolve => { window.finishSubmit = resolve }); document.querySelector('.send-button').click()`,
    );
    await see(`!!window.finishSubmit`);
    await type("");
    await run(`document.querySelector('.victor-chip').click()`);
    await phase("off");
    assert.equal(await value("audioCreated"), 0);
    await run(`pocket.actions.submit = originalSubmit; finishSubmit()`);
});

test(
    "active Victor guards typing, paste, attachments and submission; insertion preserves both drafts",
    real,
    async () => {
        await fresh();
        await type("Typed");
        await activate();
        assert.equal(await value(`document.querySelector('.composer textarea').readOnly`), true);
        assert.equal(
            await value(`document.querySelector('[aria-label="Attach files"]').disabled`),
            true,
        );
        await run(`
        window.submits = 0; window.originalSubmit = pocket.actions.submit;
        pocket.actions.submit = async () => { submits++; };
        const box = document.querySelector('.composer textarea');
        const data = new DataTransfer(); data.setData('text/plain', 'pasted'); data.items.add(new File(['x'], 'blocked.txt'));
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
        box.dispatchEvent(event); window.pasteBlocked = event.defaultPrevented;
        document.querySelector('.composer').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        document.querySelector('.send-button').click();
    `);
        assert.equal(await value("pasteBlocked"), true);
        assert.equal(await value("submits"), 0);
        assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), "Typed");
        assert.equal(await value(`document.querySelector('.composer .files') === null`), true);
        await run(
            `pocket.actions.submit = originalSubmit; pocket.insertIntoComposer('inserted text', [new File(['x'], 'inserted.txt')])`,
        );
        await phase("off");
        await see(`!!document.querySelector('[aria-label="Remove inserted.txt"]')`);
        await see(
            `document.querySelector('.composer textarea').value === 'Typed unfinished speech\\n\\ninserted text'`,
        );
        assert.equal(
            await value(`pocket.drafts.get(${JSON.stringify(first)})`),
            "Typed unfinished speech\n\ninserted text",
        );
    },
);

test("extension keys edit ordinary drafts but cannot write into Victor's draft", real, async () => {
    await fresh();
    await see("window.victorKeysLoaded === true");
    const key = (key: string) =>
        run(`document.querySelector('.composer textarea').dispatchEvent(
        new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ctrlKey: true, bubbles: true, cancelable: true })
    )`);

    await type("Typed");
    await key("w");
    await see(`document.querySelector('.composer textarea').value === 'Shortcut draft'`);
    assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), "Shortcut draft");
    await key("e");
    await see("typeof window.finishKey === 'function'");
    await activate("spoken");
    await key("w");
    await run("finishKey()");
    assert.equal(await value("window.keyCalls"), 1, "Victor blocks extension key dispatch");
    assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), "Shortcut draft");
    await run("victor.disable()");
    await phase("off");
    await see(`document.querySelector('.composer textarea').value === 'Shortcut draft spoken'`);
    await key("w");
    await see(`document.querySelector('.composer textarea').value === 'Shortcut draft'`);
    assert.equal(await value("window.keyCalls"), 2, "keys resume after Victor releases the draft");
    await key("e");
    await activate("more speech", 2);
    await run("victor.disable()");
    await phase("off");
    await run("finishKey()");
    await see(
        `document.querySelector('.composer textarea').value === 'Shortcut draft more speech'`,
    );
    assert.equal(
        await value(`pocket.drafts.get(${JSON.stringify(first)})`),
        "Shortcut draft more speech",
    );

    await key("e");
    await type("Newer typing");
    await run("finishKey()");
    assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), "Newer typing");

    await key("e");
    await run(`pocket.navigate(${JSON.stringify(second)})`);
    await see(`pocket.store.state.view.conversation?.id === ${JSON.stringify(second)}`);
    await run(`pocket.navigate(${JSON.stringify(first)})`);
    await see(`pocket.store.state.view.conversation?.id === ${JSON.stringify(first)}`);
    await run("finishKey()");
    await see(`document.querySelector('.composer textarea').value === 'Newer typing'`);
});

test(
    "navigation saves the typed and spoken draft to the captured conversation, never its replacement",
    real,
    async () => {
        await fresh();
        await type("Typed");
        await activate("captured words");
        await run(
            `pocket.drafts.set(${JSON.stringify(second)}, 'other draft'); pocket.navigate(${JSON.stringify(second)})`,
        );
        await phase("off");
        await see(`document.querySelector('.composer textarea')?.value === 'other draft'`);
        assert.equal(
            await value(`pocket.drafts.get(${JSON.stringify(first)})`),
            "Typed captured words",
        );
        assert.equal(await value(`pocket.drafts.get(${JSON.stringify(second)})`), "other draft");
    },
);

test(
    "eligibility and live connection, permission, model, busy and queue changes stay safe",
    real,
    async () => {
        for (const change of [
            `connection: 'closed'`,
            `me: { ...pocket.store.state.me, role: 'viewer' }`,
            `view: { ...pocket.store.state.view, agent: { ...pocket.store.state.view.agent, model: null } }`,
            `view: { ...pocket.store.state.view, inbox: [{}] }`,
            `view: { ...pocket.store.state.view, live: { busy: true } }`,
            `view: { ...pocket.store.state.view, turns: { on: true, driver: 'someone-else' } }`,
        ]) {
            await fresh();
            await activate("kept on change");
            await run(`pocket.store.set({ ${change} })`);
            await phase("off");
            assert.equal(
                await value(`pocket.drafts.get(${JSON.stringify(first)})`),
                "kept on change",
            );
            await run(
                `pocket.drafts.set(${JSON.stringify(first)}, ''); victor.enable({ conversationId: ${JSON.stringify(first)}, preserveDraft() {} })`,
            );
            await phase("off");
            assert.equal(await value("audioCreated"), 1, change);
        }
    },
);

test(
    "typed and spoken drafts survive repeated toggles and edits without duplication",
    real,
    async () => {
        await fresh();
        const initial = "  Typed paragraph.\n\n";

        await type(initial);
        await activate("");
        assert.equal(await value("victor.state.text"), initial);
        assert.equal(
            await value(`document.querySelector('.composer textarea').value`),
            "",
            "the active draft appears only in Victor, not twice",
        );
        assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), initial);
        await run(`document.querySelector('.victor-toggle').click()`);
        await see(
            `document.querySelector('.composer textarea').value === ${JSON.stringify(initial)}`,
        );
        await activate("spoken words", 2);
        await run(`speechWorker.onmessage({ data: { type: 'partial', text: 'revised words' } })`);
        assert.equal(await value("victor.state.text"), initial + "revised words");
        await run(`document.querySelector('.victor-toggle').click()`);
        await see(
            `document.querySelector('.composer textarea').value === ${JSON.stringify(initial + "revised words")}`,
        );
        await type("Edited draft");
        await activate("continued", 3);
        await run(`document.querySelector('.victor-toggle').click()`);
        await see(
            `document.querySelector('.composer textarea').value === 'Edited draft continued'`,
        );
        assert.equal(
            await value(`pocket.drafts.get(${JSON.stringify(first)})`),
            "Edited draft continued",
        );
    },
);

test(
    "a starting draft survives microphone failure and stopping during preparation",
    real,
    async () => {
        await fresh();
        await type("Typed before preparation\n");
        await run(`document.querySelector('.victor-chip').click(); victor.disable()`);
        await phase("off");
        assert.equal(
            await value(`pocket.drafts.get(${JSON.stringify(first)})`),
            "Typed before preparation\n",
        );
        await run(
            `window.speechWorker = null; navigator.mediaDevices.getUserMedia = async () => { throw new Error('permission denied'); }; document.querySelector('.victor-chip').click()`,
        );
        await see(`!!window.speechWorker`);
        await run(`speechWorker.onmessage({ data: { type: 'ready' } })`);
        await phase("error");
        await run(`document.querySelector('.victor-toggle').click()`);
        await see(
            `document.querySelector('.composer textarea').value === 'Typed before preparation\\n'`,
        );
    },
);

async function beginVoiceSubmit(transcript = "spoken send it", posts = 1) {
    await run(`
        window.originalFetch = window.fetch;
        window.voicePosts = [];
        window.fetch = (url, options) => {
            if (String(url).endsWith('/submit')) {
                voicePosts.push(JSON.parse(options.body));
                return new Promise(resolve => { window.finishVictorSubmit = status => resolve(new Response(JSON.stringify(status === 200 ? {} : { error: 'rejected' }), { status, headers: { 'Content-Type': 'application/json' } })); });
            }
            return originalFetch(url, options);
        };
        window.finalTranscript = ${JSON.stringify(transcript)};
        speechWorker.onmessage({ data: { type: 'partial', turn: speechWorker.turn, text: finalTranscript } });
    `);
    await see(`voicePosts.length === ${posts}`);
}

test("a changed saved draft prevents Victor submission and keeps both texts", real, async () => {
    await fresh();
    await type("Original");
    await activate("");
    await run(`pocket.drafts.set(${JSON.stringify(first)}, 'Changed elsewhere')`);
    await beginVoiceSubmit("spoken send it", 0);
    await phase("error");
    assert.equal(await value("voicePosts.length"), 0);
    await run(`window.fetch = originalFetch; victor.disable()`);
    await see(
        `document.querySelector('.composer textarea').value === 'Changed elsewhere\\n\\nOriginal spoken'`,
    );
});

async function endVoiceSubmit(status: number) {
    await run(`window.fetch = originalFetch; finishVictorSubmit(${status})`);
}

test(
    "folded pastes expand for Victor and spoken send it sends the existing draft",
    real,
    async () => {
        await fresh();
        const pasted = "Literal [Pasted text #1] is part of this document.\n".repeat(25);

        await paste(pasted);
        await activate("");
        assert.equal(await value("victor.state.text"), pasted);
        await run(`victor.disable()`);
        await see(
            `document.querySelector('.composer textarea').value === ${JSON.stringify(pasted)}`,
        );
        await activate("", 2);
        assert.equal(
            await value("victor.state.text"),
            pasted,
            "literal placeholders must not expand again",
        );
        await beginVoiceSubmit("send it");
        assert.equal(await value("voicePosts[0].text"), pasted.trim());
        assert.equal(await value("voicePosts[0].source"), "victor");
        assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), "");
        await endVoiceSubmit(200);
        await phase("waiting");
        await run(`victor.disable()`);
        await see(`document.querySelector('.composer textarea').value === ''`);
    },
);

test("folded commands and send-mentioned-files drafts stay protected", real, async () => {
    await fresh();
    await paste("/help\n".repeat(25));
    await run(`document.querySelector('.victor-chip').click()`);
    await phase("off");
    assert.equal(await value("audioCreated"), 0, "folding cannot hide a command from validation");
    await run(`localStorage.setItem('pocket.inlineFiles', '1')`);
    await fresh();
    await type("Read @file.txt please");
    await run(`document.querySelector('.victor-chip').click()`);
    await phase("off");
    assert.equal(await value("audioCreated"), 0);
    await type("");
    await paste("Read @file.txt please\n".repeat(25));
    await run(`document.querySelector('.victor-chip').click()`);
    await phase("off");
    assert.equal(await value("audioCreated"), 0, "folded file mentions keep their send semantics");
    await run(`localStorage.setItem('pocket.inlineFiles', '0')`);
    await fresh();
    await type("Read @file.txt please");
    await activate("");
    await run(`victor.disable()`);
});

test("Victor hides file suggestions and rejects a stale suggestion click", real, async () => {
    await fresh();
    await type("Read @victor-draft");
    await see(`!!document.querySelector('.file-option')`);
    await run(`window.staleFileChoice = document.querySelector('.file-option')`);
    await activate("spoken");
    await see(`!document.querySelector('.file-options')`);
    await run(`staleFileChoice.click()`);
    assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), "Read @victor-draft");
    assert.equal(await value("victor.state.text"), "Read @victor-draft spoken");
    await run(`victor.disable()`);
    await see(`document.querySelector('.composer textarea').value === 'Read @victor-draft spoken'`);
});

for (const status of [200, 403, 500]) {
    test(
        `late Victor HTTP ${status} does not erase a remounted composer's newer draft`,
        real,
        async () => {
            await fresh();
            await type("Typed");
            await activate("");
            await beginVoiceSubmit();
            await run(`victor.disable(); pocket.navigate(${JSON.stringify(second)})`);
            await see(
                `pocket.store.state.view.conversation?.id === ${JSON.stringify(second)} && !!document.querySelector('.composer textarea')`,
            );
            await type("Other conversation message");
            await see(`!document.querySelector('.send-button').disabled`);
            await run(`document.querySelector('.victor-chip').click()`);
            await phase("off");
            assert.equal(await value("audioCreated"), 1, "reactivation is still blocked tab-wide");
            await run(`
                window.originalSubmit = pocket.actions.submit;
                window.typedSends = [];
                pocket.actions.submit = async text => { typedSends.push(text); return true; };
                document.querySelector('.send-button').click();
            `);
            await see(
                `typedSends.length === 1 && document.querySelector('.composer textarea').value === ''`,
            );
            assert.equal(await value("typedSends[0]"), "Other conversation message");
            await run(`pocket.actions.submit = originalSubmit`);
            await type("Other conversation draft");
            await run(`pocket.navigate(${JSON.stringify(first)})`);
            await see(
                `pocket.store.state.view.conversation?.id === ${JSON.stringify(first)} && document.querySelector('.composer textarea')?.value === ''`,
            );
            await type("Newer draft");
            assert.equal(
                await value(`document.querySelector('.send-button').disabled`),
                true,
                "ordinary sends must not race a pending Victor rejection",
            );
            await run(
                `document.querySelector('.send-button').click(); document.querySelector('.victor-chip').click()`,
            );
            await phase("off");
            assert.equal(await value("audioCreated"), 1, "pending delivery prevents reactivation");
            await endVoiceSubmit(status);
            const expected = status === 403 ? "Newer draft\n\nTyped spoken" : "Newer draft";

            await see(
                `document.querySelector('.composer textarea').value === ${JSON.stringify(expected)}`,
            );
            await see(`!document.querySelector('.send-button').disabled`);
            assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), expected);
            assert.equal(
                await value(`pocket.drafts.get(${JSON.stringify(second)})`),
                "Other conversation draft",
                "late delivery must not change the other conversation's draft",
            );
            await activate("continued", 2);
            await run(`victor.disable()`);
            await see(
                `document.querySelector('.composer textarea').value === ${JSON.stringify(expected + " continued")}`,
            );
        },
    );
}

/** Measure the laid-out controls, including children whose overflow could be clipped by the app shell. */
async function layout() {
    // The composer animates into place; measure its settled touch targets rather than scaled frames.
    await new Promise((resolve) => setTimeout(resolve, 450));

    return value(`(() => {
        const rect = (element) => {
            const bounds = element.getBoundingClientRect();
            return { width: bounds.width, height: bounds.height, left: bounds.left, right: bounds.right };
        };
        const visible = (selector) => {
            const element = document.querySelector(selector);
            return !!element && element.getClientRects().length > 0 && rect(element).width > 0;
        };
        return {
            viewport: innerWidth,
            coarse: matchMedia('(pointer: coarse)').matches,
            composerWidth: document.querySelector('.composer').clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            plan: visible('.plan-chip'),
            thinking: visible('.model-level'),
            chip: visible('.victor-chip'),
            readonly: document.querySelector('.composer textarea').readOnly,
            controls: [...document.querySelectorAll('.victor-mode-row button, .victor-speed select')]
                .map(rect),
            bounds: [...document.querySelectorAll('.composer, .composer-row, .composer-row > *, .victor-mode, .victor-mode-row > *, .victor-draft, .victor-message')]
                .filter(element => element.getClientRects().length > 0).map(rect),
        };
    })()`);
}

function fits(measured: Awaited<ReturnType<typeof layout>>, width: number, state: string) {
    assert.equal(measured.viewport, width);
    assert.ok(measured.scrollWidth <= width, `${width}px ${state}: document overflow`);

    for (const bounds of measured.bounds) {
        assert.ok(
            bounds.left >= -1 && bounds.right <= width + 1,
            `${width}px ${state}: control outside viewport ${JSON.stringify(bounds)}`,
        );
    }
}

test(
    "Victor layouts fit narrow phones and desktop, with usable controls and restored draft focus",
    real,
    async () => {
        for (const width of [320, 375, 390, 600, 1280]) {
            await page.setViewport({ width, height: 844, scale: 1, mobile: width < 600 });
            await fresh();
            await run(
                `pocket.store.set({ view: { ...pocket.store.state.view, agent: { ...pocket.store.state.view.agent, reasoning: true, thinkingLevel: 'high' } } })`,
            );
            await see(`!!document.querySelector('.model-level')`);
            const off = await layout();

            fits(off, width, "off");
            assert.equal(off.chip, true);
            assert.equal(off.plan, off.composerWidth > 340, `${width}px Plan visibility`);
            assert.equal(off.thinking, off.composerWidth > 420, `${width}px thinking visibility`);
            const draft = "Preserve these unfinished words " + "longword".repeat(30);

            await activate(draft);
            await see(`!!document.querySelector('.victor-draft')`);
            const on = await layout();

            fits(on, width, "on");
            assert.equal(on.readonly, true);
            assert.equal(on.controls.length, 3);

            for (const control of on.controls) {
                assert.ok(
                    control.height >= (on.coarse ? 40 : 30) && control.width >= 40,
                    `${width}px Victor control ${JSON.stringify(control)}`,
                );
            }

            await run(
                `speechWorker.onmessage({ data: { type: 'error', message: 'Resource failure ' + 'unbroken'.repeat(30) } })`,
            );
            await phase("error");
            await see(`!!document.querySelector('.victor-mode.error')`);
            const error = await layout();

            fits(error, width, "error");
            assert.equal(error.readonly, true);
            await page.click({ selector: ".victor-toggle" });
            await phase("off");
            await see(
                `document.querySelector('.composer textarea').value === ${JSON.stringify(draft)}`,
            );
            assert.equal(
                await value(`document.querySelector('.composer textarea').readOnly`),
                false,
            );
            await page.click({ selector: ".composer textarea" });
            assert.equal(
                await value(
                    `document.activeElement === document.querySelector('.composer textarea')`,
                ),
                true,
            );
            await page.type({ selector: ".composer textarea" }, "Normal typed draft after Victor");
            await see(
                `pocket.drafts.get(${JSON.stringify(first)}) === 'Normal typed draft after Victor'`,
            );
            fits(await layout(), width, "disabled");
        }
    },
);

test("reordered composer slots preserve Victor ownership and its stop control", real, async () => {
    await fresh();
    await run(`(await import('/theme.js')).setPrefs({ layout: { composer: {
        order: ['core:attach', 'core:plan', 'core:model', 'core:places'],
        hidden: { 'core:model': true, 'core:plan': true }
    } } })`);

    try {
        await type("Typed");
        await activate("spoken");
        assert.equal(await value(`document.querySelector('.attach-button').disabled`), true);
        assert.equal(await value(`document.querySelector('input[type="file"]').disabled`), true);
        assert.equal(await value(`document.querySelector('.model-chip') === null`), true);
        await run(`document.querySelector('.victor-toggle').click()`);
        await phase("off");
        await see(`document.querySelector('.composer textarea').value === 'Typed spoken'`);
        assert.equal(await value(`document.querySelector('.attach-button').disabled`), false);
    } finally {
        await run(`victor.disable(); (await import('/theme.js')).setPrefs({ layout: {} })`);
    }
});

test("Victor waiting layouts keep Interrupt separate from voice sends", real, async () => {
    for (const width of [320, 350, 390, 1280]) {
        await page.setViewport({ width, height: 844, scale: 1, mobile: width < 600 });
        await fresh();
        await activate("");
        await beginVoiceSubmit();
        await run(
            `pocket.store.set({ view: { ...pocket.store.state.view, live: { busy: true } } })`,
        );
        await see(`document.querySelectorAll('.mode-switch button').length === 3`);
        await run(`document.querySelector('.mode-switch .interrupt').click()`);
        assert.equal(await value("voicePosts[0].mode"), "followUp");
        assert.equal(await value(`document.querySelector('.send-button').disabled`), true);
        await endVoiceSubmit(200);
        await phase("waiting");
        const measured = await layout();

        fits(measured, width, "waiting for reply");
        assert.equal(measured.chip, false);
        assert.equal(measured.readonly, true);
        assert.equal(await value(`document.querySelector('.send-button').disabled`), true);
        assert.equal(
            await value(`document.querySelector('.stop-button').getBoundingClientRect().width > 0`),
            true,
        );
        await run(
            `victor.disable(); pocket.store.set({ view: { ...pocket.store.state.view, live: { busy: false } } })`,
        );
        await phase("off");
    }
});

test(
    "Victor follows themes, density and text size without borrowing Plan styles",
    real,
    async () => {
        for (const [width, look, theme, density, text] of [
            [320, "pocket", "tokyo-night", "comfortable", 15],
            [390, "pocket", "flexoki-light", "tight", 17],
            [320, "pocket", "tokyo-night", "comfortable", 32],
            [390, "pocket", "flexoki-light", "tight", 10],
            [1280, "lantern", "lantern", "compact", 13],
        ] as const) {
            await page.setViewport({ width, height: 844, scale: 1, mobile: width < 600 });
            await fresh();
            await run(
                `(await import('/theme.js')).setPrefs(${JSON.stringify({ look, theme, density, text })})`,
            );
            await see(`document.documentElement.dataset.theme === ${JSON.stringify(look)}`);

            // Folder themes load asynchronously. Wait for Lantern's documented corner token too.
            if (look === "lantern") {
                await see(
                    `getComputedStyle(document.documentElement).getPropertyValue('--r-card').trim() === '8px'`,
                );
            }

            fits(await layout(), width, `${look} off`);
            assert.equal(
                await value(`document.querySelector('.victor-chip').dataset.part`),
                "composer-button",
            );
            assert.equal(
                await value(
                    `document.querySelector('.victor-chip').classList.contains('plan-chip')`,
                ),
                false,
            );
            await activate("A draft at the person's chosen text size.");
            const measured = await layout();
            const styles = await value(`(() => {
            const css = selector => getComputedStyle(document.querySelector(selector));
            const root = getComputedStyle(document.documentElement);
            return {
                radius: css('.victor-mode').borderRadius,
                expectedRadius: root.getPropertyValue('--r-card').trim(),
                padding: parseFloat(css('.victor-mode').paddingTop),
                expectedPadding: 8 * parseFloat(root.getPropertyValue('--space-y')),
                draft: parseFloat(css('.victor-draft').fontSize),
                status: parseFloat(css('.victor-status').fontSize),
                field: parseFloat(css('.victor-speed select').fontSize),
            };
        })()`);

            fits(measured, width, `${look} listening`);
            assert.equal(styles.radius, styles.expectedRadius);
            assert.ok(Math.abs(styles.padding - styles.expectedPadding) < 0.1);
            assert.equal(styles.draft, measured.coarse ? Math.max(16, text) : text);
            assert.ok(styles.status >= 13);

            if (measured.coarse) {
                assert.ok(styles.field >= 16, "fields retain upstream's iOS zoom protection");
            }

            await run(
                `speechWorker.onmessage({ data: { type: 'error', message: 'Microphone interrupted. Draft kept.' } })`,
            );
            await phase("error");
            await see(`!!document.querySelector('.victor-message.error-box[role="alert"]')`);
            assert.equal(
                await value(
                    `document.querySelector('.victor-toggle').getAttribute('aria-pressed')`,
                ),
                "true",
            );
            assert.equal(
                await value(`document.querySelectorAll('.victor-mode [role="status"]').length`),
                0,
            );
            // Compare with the shared error primitive, not hard-coded palette values.
            await run(
                `window.reference = document.createElement('div'); reference.className = 'error-box'; document.body.append(reference)`,
            );
            const errors =
                await value(`['color', 'backgroundColor', 'borderColor', 'borderRadius', 'fontSize'].map(key =>
            [getComputedStyle(document.querySelector('.victor-message'))[key], getComputedStyle(reference)[key]])`);

            for (const [actual, expected] of errors) {
                assert.equal(actual, expected);
            }

            await run(`reference.remove(); document.querySelector('.victor-toggle').click()`);
            await phase("off");
        }

        await run(
            `(await import('/theme.js')).setPrefs({ look: 'pocket', theme: 'tokyo-night', density: 'comfortable', text: 15 })`,
        );
    },
);

test(
    "Victor's idle touch target and keyboard focus stay separate from neighbouring controls",
    real,
    async () => {
        await page.setViewport(VIEWPORTS.mobile);
        await fresh();

        for (const density of ["comfortable", "compact", "tight"]) {
            await run(
                `(await import('/theme.js')).setPrefs({ density: ${JSON.stringify(density)} })`,
            );
            await layout();
            const hits = await value(`(() => {
        const chip = document.querySelector('.victor-chip');
        const rect = chip.getBoundingClientRect();
        const owns = (element, x, y) => element.contains(document.elementFromPoint(x, y));
        return {
            height: rect.height,
            targetHeight: parseFloat(getComputedStyle(chip, '::before').height),
            above: owns(chip, rect.x + rect.width / 2, rect.top - 4.9),
            below: owns(chip, rect.x + rect.width / 2, rect.bottom + 4.9),
            neighbours: [...document.querySelectorAll('.composer-row button:not(.victor-chip):not(:disabled)')]
                .filter(element => element.getClientRects().length)
                .every(element => {
                    const r = element.getBoundingClientRect();
                    return owns(element, r.left + 2, r.y + r.height / 2) && owns(element, r.right - 2, r.y + r.height / 2);
                }),
        };
    })()`);

            assert.ok(hits.height >= 30);
            assert.ok(hits.targetHeight >= 40);
            assert.equal(
                hits.above,
                true,
                `${density}: top of expanded touch target belongs to Victor`,
            );
            assert.equal(
                hits.below,
                true,
                `${density}: bottom of expanded touch target belongs to Victor`,
            );
            assert.equal(
                hits.neighbours,
                true,
                `${density}: Victor takes no neighbouring button's taps`,
            );
        }

        await run(`(await import('/theme.js')).setPrefs({ density: 'comfortable' })`);
        await page.setViewport(VIEWPORTS.desktop);
        await fresh();
        await run(`document.querySelector('.plan-chip').focus()`);
        await page.press("Tab");
        assert.equal(
            await value(`document.activeElement.matches('.victor-chip:focus-visible')`),
            true,
        );
        assert.notEqual(
            await value(`getComputedStyle(document.activeElement).outlineStyle`),
            "none",
        );
        await page.press("Enter");
        await phase("preparing");
        await see(`!!document.querySelector('.victor-status .spinner[aria-hidden="true"]')`);
        assert.equal(
            await value(`document.querySelectorAll('.victor-mode [role="status"]').length`),
            1,
        );
        await run(`document.querySelector('.victor-toggle').click()`);
        await phase("off");
    },
);

test("Victor responds to composer width rather than desktop viewport width", real, async () => {
    await page.setViewport(VIEWPORTS.desktop);
    await fresh();
    await run(
        `pocket.store.set({ view: { ...pocket.store.state.view, agent: { ...pocket.store.state.view.agent, reasoning: true, thinkingLevel: 'high' } } })`,
    );
    await see(`!!document.querySelector('.model-level')`);
    const roomy = await layout();

    assert.equal(roomy.plan, true);
    assert.equal(roomy.thinking, true);
    // Constrain the real composer region without changing the desktop's viewport or pointer type.
    await run(`document.querySelector('[data-part="composer"]').style.width = '360px'`);
    const narrow = await layout();

    assert.equal(narrow.viewport, roomy.viewport);
    assert.equal(narrow.plan, false);
    assert.equal(narrow.thinking, false);
    assert.equal(narrow.chip, true);
    const contained = await value(`(() => {
        const box = document.querySelector('.composer').getBoundingClientRect();
        return [...document.querySelectorAll('.composer-row > *')].filter(element => element.getClientRects().length)
            .every(element => { const r = element.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right; });
    })()`);

    assert.equal(contained, true, "all controls stay inside the narrow composer");
    await run(`document.querySelector('[data-part="composer"]').style.width = ''`);
});
