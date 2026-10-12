// Real Composer and Victor controller in an isolated app. Only browser speech resources are fake;
// these checks say nothing about recognition accuracy or physical audio routing.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";
import { type App, cleanUp, newSession, openApp, root, until } from "./helpers.ts";

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

    app = await openApp(fauxProvider());
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
            postMessage() {}
            terminate() {}
        };
        window.AudioContext = class {
            constructor() { audioCreated++; this.sampleRate = 48000; this.state = 'running'; this.audioWorklet = { addModule: async () => {} }; }
            addEventListener() {}
            resume() { return Promise.resolve(); }
            close() { return Promise.resolve(); }
        };
        window.AudioWorkletNode = class {};
        navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
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

async function activate(text = "unfinished speech") {
    await run(`document.querySelector('.victor-chip').click(); window.audioOnTap = audioCreated`);
    await phase("preparing");
    assert.equal(await value("audioOnTap"), 1, "audio is created on the original tap");
    await see(`!!window.speechWorker`);
    await run(
        `speechWorker.onmessage({ data: { type: 'ready' } }); speechWorker.onmessage({ data: { type: 'partial', text: ${JSON.stringify(text)} } })`,
    );
    await phase("listening");
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
            "victor-controls.js",
            "victor-cache.js",
            "victor.css",
            "voice.js",
        ]) {
            assert.equal((await fetch(`${base}/${file}`)).status, 200, file);
        }

        const appPage = await fetch(`${base}/`);

        assert.match(await appPage.text(), /href="\/victor\.css"/);
    },
);

test(
    "drafts, attachments, and an outstanding typed submission prevent activation",
    real,
    async () => {
        await fresh();
        await type("typed draft");
        await run(`document.querySelector('.victor-chip').click()`);
        await phase("off");
        assert.equal(await value("audioCreated"), 0);
        await type("");
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
    },
);

test(
    "active Victor guards typing, paste, attachments and submission; insertion preserves both drafts",
    real,
    async () => {
        await fresh();
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
        assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), "");
        assert.equal(await value(`document.querySelector('.composer .files') === null`), true);
        await run(
            `pocket.actions.submit = originalSubmit; pocket.insertIntoComposer('inserted text', [new File(['x'], 'inserted.txt')])`,
        );
        await phase("off");
        await see(`!!document.querySelector('[aria-label="Remove inserted.txt"]')`);
        await see(`document.querySelector('.composer textarea').value.includes('inserted text')`);
        assert.equal(
            await value(`pocket.drafts.get(${JSON.stringify(first)})`),
            "unfinished speech\n\ninserted text",
        );
    },
);

test(
    "navigation saves unfinished speech to the captured conversation, never its replacement",
    real,
    async () => {
        await fresh();
        await activate("captured words");
        await run(
            `pocket.drafts.set(${JSON.stringify(second)}, 'other draft'); pocket.navigate(${JSON.stringify(second)})`,
        );
        await phase("off");
        await see(`document.querySelector('.composer textarea')?.value === 'other draft'`);
        assert.equal(await value(`pocket.drafts.get(${JSON.stringify(first)})`), "captured words");
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
            scrollWidth: document.documentElement.scrollWidth,
            plan: visible('.plan-chip'),
            thinking: visible('.model-level'),
            chip: visible('.victor-chip'),
            readonly: document.querySelector('.composer textarea').readOnly,
            controls: [...document.querySelectorAll('.victor-mode-row button, .victor-speed select')]
                .map(element => ({ ...rect(element), readReply: element.matches('.button.small') })),
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
        for (const width of [320, 390, 1280]) {
            await page.setViewport({ width, height: 844, scale: 1, mobile: width < 600 });
            await fresh();
            await run(
                `pocket.store.set({ view: { ...pocket.store.state.view, agent: { ...pocket.store.state.view.agent, reasoning: true, thinkingLevel: 'high' } } })`,
            );
            await see(`!!document.querySelector('.model-level')`);
            const off = await layout();

            fits(off, width, "off");
            assert.equal(off.chip, true);
            assert.equal(off.plan, width > 379, `${width}px Plan visibility`);
            assert.equal(off.thinking, width > 699, `${width}px thinking visibility`);
            const draft = "Preserve these unfinished words " + "longword".repeat(30);

            await activate(draft);
            await see(`!!document.querySelector('.victor-draft')`);
            const on = await layout();

            fits(on, width, "on");
            assert.equal(on.readonly, true);
            assert.equal(on.controls.length, 3);

            for (const control of on.controls) {
                // Existing shared .button.small mobile rules override Read reply's 40px minimum.
                // Preserve that pre-extraction baseline; toggle and speed remain at least 40px.
                const minimum = control.readReply && width < 600 ? 38 : 40;

                assert.ok(
                    control.height >= minimum && control.width >= 40,
                    `${width}px Victor touch target ${JSON.stringify(control)}`,
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
