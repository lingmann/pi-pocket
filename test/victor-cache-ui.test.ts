// Versioned victor bytes survive page and dedicated-worker teardown in real Chromium. The isolated server serves
// only tiny fixtures for this test, never the production speech models.
import { type App, cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
    timeout: 60_000,
} as const;
const FIRST = "/victor-assets/test-bundle/model.bin";
const MISSING = "/victor-assets/test-bundle/tts/pronunciation.data";
const SECOND = "/victor-assets/test-bundle-next/tts/pronunciation.data";
const FIRST_CACHE = "pocket-victor-test-bundle";
const SECOND_CACHE = "pocket-victor-test-bundle-next";
const LEGACY_CACHE = "pocket-victor-older-test-bundle";
const FIXTURES = new Map([
    [FIRST, Buffer.from([0, 1, 127, 128, 254, 255, 13, 10])],
    [MISSING, Buffer.from("tiny pronunciation fixture\n")],
    [SECOND, Buffer.from([255, 0, 42, 99, 128])],
]);
const FAILURE = FIXTURES.get(MISSING)!.subarray(0, 5);
const PRESERVED = [
    { name: "pocket-share", path: "/share/victor-cache-test/meta", text: "a pending share" },
    { name: "unrelated-cache", path: "/unrelated-cache-test", text: "unrelated bytes" },
    {
        name: "pocket-victorish-unrelated",
        path: "/victorish-cache-test",
        text: "not a victor cache",
    },
];
/** Fetch from a classic dedicated worker, as victor-worker.js does, not from the window. */
const FETCH_WORKER = `
    self.onmessage = async ({ data: paths }) => {
        try {
            const assets = [];

            for (const path of paths) {
                const response = await fetch(path);

                assets.push({
                    path,
                    status: response.status,
                    bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
                    type: response.headers.get("content-type"),
                    etag: response.headers.get("etag"),
                });
            }

            self.postMessage({ assets });
        } catch (error) {
            self.postMessage({ error: String(error) });
        }
    };
`;

type Asset = {
    path: string;
    status: number;
    bytes: number[];
    type: string | null;
    etag: string | null;
};
type Transfer = { requests: number; bytes: number };

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let failMissing = true;
let helperRevision = 0;
let helperRequests = 0;
const transfers = new Map<string, Transfer>();
const unexpectedVictorRequests: string[] = [];

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Every batch uses a new worker and terminates it, including before the page reload. */
async function fetchAssets(...paths: string[]): Promise<Asset[]> {
    return inPage<Asset[]>(`
        const worker = new Worker("/victor-cache-test-worker.js");

        try {
            const assets = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Fixture worker timed out")), 10_000);

                worker.onmessage = ({ data }) => {
                    clearTimeout(timer);
                    data.error ? reject(new Error(data.error)) : resolve(data.assets);
                };
                worker.onerror = (event) => {
                    clearTimeout(timer);
                    reject(new Error(event.message));
                };
                worker.postMessage(${JSON.stringify(paths)});
            });

            return JSON.stringify(assets);
        } finally {
            worker.terminate();
        }
    `);
}

const cacheNames = () => inPage<string[]>(`return JSON.stringify((await caches.keys()).sort())`);

/** Do not open an absent cache: a cleanup assertion must not recreate the cache it is checking. */
async function cachePaths(name: string): Promise<string[]> {
    return inPage<string[]>(`
        const name = ${JSON.stringify(name)};

        if (!(await caches.has(name))) {
            return JSON.stringify([]);
        }

        const cache = await caches.open(name);
        const requests = await cache.keys();

        return JSON.stringify(requests.map((request) => new URL(request.url).pathname).sort());
    `);
}

/** Cache writes use event.waitUntil and may finish after the fetch has returned its body. */
async function cached(name: string, paths: string[]): Promise<void> {
    await until(
        async () => JSON.stringify(await cachePaths(name)) === JSON.stringify([...paths].sort()),
        `${name} to contain ${paths.join(", ")}`,
    );
}

async function controlled(): Promise<void> {
    await until(
        async () =>
            inPage<boolean>(`
                const registration = await navigator.serviceWorker.getRegistration("/");
                const controller = navigator.serviceWorker.controller;

                return JSON.stringify(
                    registration?.active?.state === "activated" &&
                    registration.active.scriptURL === location.origin + "/sw.js" &&
                    controller?.state === "activated" &&
                    controller.scriptURL === location.origin + "/sw.js"
                );
            `),
        "/sw.js installed and controlling the app",
        20_000,
    );
}

function asset(path: string): Asset {
    return {
        path,
        status: 200,
        bytes: [...FIXTURES.get(path)!],
        type: "application/octet-stream",
        etag: '"victor-cache-fixture"',
    };
}

/** Count bytes at the server, rather than inferring network use from Resource Timing or HTTP caching. */
function transferred(expected: [string, number, number][]): void {
    assert.deepEqual(
        [...transfers].sort(([a], [b]) => a.localeCompare(b)),
        expected
            .map(([path, requests, bytes]): [string, Transfer] => [path, { requests, bytes }])
            .sort(([a], [b]) => a.localeCompare(b)),
        "only missing victor bytes reach the HTTP server",
    );
    assert.deepEqual(unexpectedVictorRequests, [], "no production models were requested");
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://pocket.local").pathname;

        if (path === "/victor-cache.js") {
            helperRequests++;

            // Initial installation uses the production handler. Only the imported script changes
            // during update; /sw.js stays byte-for-byte identical.
            if (helperRevision > 0) {
                response.writeHead(200, {
                    "content-type": "text/javascript; charset=utf-8",
                    "cache-control": "no-cache",
                });
                response.end(
                    readFileSync(new URL("../web/victor-cache.js", import.meta.url), "utf8") +
                        `\n// Isolated update revision ${helperRevision}\n`,
                );

                return;
            }
        }

        if (path === "/victor-cache-test-worker.js") {
            response.writeHead(200, {
                "content-type": "text/javascript; charset=utf-8",
                "cache-control": "no-store",
                "content-security-policy":
                    "default-src 'none'; script-src 'self'; connect-src 'self'",
            });
            response.end(FETCH_WORKER);

            return;
        }

        if (path.startsWith("/victor-assets/")) {
            const fixture = FIXTURES.get(path);

            if (fixture === undefined || request.method !== "GET") {
                unexpectedVictorRequests.push(path);
                response.writeHead(404);
                response.end();

                return;
            }

            assert.equal(request.headers.range, undefined, "pack retries request the whole body");
            const failed = path === MISSING && failMissing;
            const bytes = failed ? FAILURE : fixture;
            const prior = transfers.get(path) ?? { requests: 0, bytes: 0 };

            transfers.set(path, {
                requests: prior.requests + 1,
                bytes: prior.bytes + bytes.length,
            });
            response.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-length": fixture.length,
                // Ordinary HTTP caching must not make a broken service-worker cache look warm.
                "cache-control": "no-store",
                etag: '"victor-cache-fixture"',
            });

            if (failed) {
                // Send a real prefix, then break the body after Chromium has received the headers.
                response.write(bytes);
                setTimeout(() => response.destroy(), 50);
            } else {
                response.end(bytes);
            }

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "victor-cache-ui-")),
        executable: chromium,
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            inPage<boolean>(`
                const { store } = await import("/store.js");

                return JSON.stringify(store.state.me !== null && location.pathname === "/");
            `),
        "the signed-in app",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "victor fixtures persist across reload, resume partial bundles, and replace only victor caches",
    real,
    async () => {
        // The app's normal registration must install and claim the page; the test does not register its own worker.
        await controlled();
        assert.deepEqual(page.viewport, VIEWPORTS.mobile);
        assert.deepEqual(
            await inPage<number[]>(`return JSON.stringify([innerWidth, innerHeight])`),
            [390, 844],
        );
        transferred([]);
        assert.ok(helperRequests > 0, "the classic service worker imported its helper");

        for (const path of ["/sw.js", "/victor-cache.js", "/service-worker.js"]) {
            const response = await fetch(base + path);

            assert.equal(response.status, 200, `${path} is served`);
            assert.match(response.headers.get("content-type")!, /javascript/);
            assert.equal(response.headers.get("cache-control"), "no-cache");
        }

        const appResponse = await fetch(base);

        assert.match(appResponse.headers.get("content-security-policy")!, /script-src 'self'/);
        assert.match(appResponse.headers.get("content-security-policy")!, /worker-src 'self'/);
        assert.deepEqual(await cacheNames(), [], "installation does not pre-cache victor assets");
        await page.evaluate(`
            for (const { name, path, text } of ${JSON.stringify(PRESERVED)}) {
                const cache = await caches.open(name);

                await cache.put(path, new Response(text));
            }
        `);

        const cold = await fetchAssets(FIRST);
        const firstBytes = FIXTURES.get(FIRST)!.length;
        const missingBytes = FIXTURES.get(MISSING)!.length;
        const secondBytes = FIXTURES.get(SECOND)!.length;

        assert.deepEqual(
            cold,
            [asset(FIRST)],
            "cold worker receives exact bytes and response headers",
        );
        transferred([[FIRST, 1, firstBytes]]);
        await cached(FIRST_CACHE, [FIRST]);

        const previousHelperRequests = helperRequests;

        helperRevision++;
        assert.equal(
            await inPage<boolean>(`
                const registration = await navigator.serviceWorker.getRegistration("/");
                const previous = navigator.serviceWorker.controller;
                const changed = new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        navigator.serviceWorker.removeEventListener("controllerchange", check);
                        reject(new Error("Imported helper update did not take control"));
                    }, 15000);
                    const check = () => {
                        if (navigator.serviceWorker.controller !== previous) {
                            clearTimeout(timeout);
                            navigator.serviceWorker.removeEventListener("controllerchange", check);
                            resolve(true);
                        }
                    };

                    navigator.serviceWorker.addEventListener("controllerchange", check);
                });

                await registration.update();

                return JSON.stringify(await changed);
            `),
            true,
            "changing only the imported helper installs and claims a new worker",
        );
        assert.ok(helperRequests > previousHelperRequests, "update checks the imported script");
        await controlled();
        assert.deepEqual(await fetchAssets(FIRST), cold, "helper update preserves cached bytes");
        assert.deepEqual(
            page.logs().filter((entry) => entry.level === "error"),
            [],
            "installation and imported-helper update have no browser errors",
        );
        transferred([[FIRST, 1, firstBytes]]);

        await page.reload({ wait: true });
        await controlled();
        assert.deepEqual(
            await fetchAssets(FIRST),
            cold,
            "a new worker after reload reads the same bytes",
        );
        transferred([[FIRST, 1, firstBytes]]);

        // An interrupted pack body must not become a cached, truncated success response.
        await assert.rejects(fetchAssets(FIRST, MISSING), /Failed to fetch|network|body/i);
        await cached(FIRST_CACHE, [FIRST]);
        transferred([
            [FIRST, 1, firstBytes],
            [MISSING, 1, FAILURE.length],
        ]);
        failMissing = false;
        await page.reload({ wait: true });
        await controlled();
        assert.deepEqual(await fetchAssets(FIRST, MISSING), [asset(FIRST), asset(MISSING)]);
        transferred([
            [FIRST, 1, firstBytes],
            [MISSING, 2, FAILURE.length + missingBytes],
        ]);
        await cached(FIRST_CACHE, [FIRST, MISSING]);
        assert.deepEqual(
            await fetchAssets(MISSING),
            [asset(MISSING)],
            "a new dedicated worker reuses the pack",
        );
        await page.reload({ wait: true });
        await controlled();
        assert.deepEqual(await fetchAssets(FIRST, MISSING), [asset(FIRST), asset(MISSING)]);
        transferred([
            [FIRST, 1, firstBytes],
            [MISSING, 2, FAILURE.length + missingBytes],
        ]);

        // More than one old bundle may exist, but similarly named unrelated caches are not victor caches.
        await page.evaluate(`
            const cache = await caches.open(${JSON.stringify(LEGACY_CACHE)});

            await cache.put("/victor-assets/older-test-bundle/model.bin", new Response("old bytes"));
        `);
        assert.deepEqual(
            await cacheNames(),
            [...PRESERVED.map(({ name }) => name), FIRST_CACHE, LEGACY_CACHE].sort(),
        );
        assert.deepEqual(await fetchAssets(SECOND), [asset(SECOND)]);
        transferred([
            [FIRST, 1, firstBytes],
            [MISSING, 2, FAILURE.length + missingBytes],
            [SECOND, 1, secondBytes],
        ]);
        await cached(SECOND_CACHE, [SECOND]);
        const remaining = [...PRESERVED.map(({ name }) => name), SECOND_CACHE].sort();

        await until(
            async () => JSON.stringify(await cacheNames()) === JSON.stringify(remaining),
            "only the current victor bundle and unrelated caches to remain",
        );
        assert.deepEqual(await cacheNames(), remaining);
        assert.deepEqual(
            await inPage<(string | null)[]>(`
                const texts = [];

                for (const { name, path } of ${JSON.stringify(PRESERVED)}) {
                    const cache = await caches.open(name);
                    const response = await cache.match(path);

                    texts.push(response ? await response.text() : null);
                }

                return JSON.stringify(texts);
            `),
            PRESERVED.map(({ text }) => text),
            "share and unrelated cache entries keep their bytes",
        );
    },
);
