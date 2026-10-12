// Exercise the real service worker with browser Request/Response objects and controlled Cache Storage.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../web/sw.js", import.meta.url), "utf8");
const helperSource = await readFile(new URL("../web/victor-cache.js", import.meta.url), "utf8");
const origin = "https://pocket.test";
const bundle = `victor-${"a".repeat(64)}`;
const cacheName = `pocket-victor-${bundle}`;
const asset = (name = "encoder.onnx", version = bundle) =>
    `${origin}/victor-assets/${version}/${name}`;
const request = (url = asset(), init?: RequestInit) => new Request(url, init);

type Storage = Map<string, Map<string, Response>>;
type Event = {
    request: Request;
    respondWith: (response: Promise<Response> | Response) => void;
    waitUntil: (work: Promise<unknown>) => void;
};

function worker(
    options: {
        storage?: Storage;
        failures?: Set<string>;
        keysGate?: Promise<void>;
        putGate?: Promise<void>;
        network?: (request: Request) => Promise<Response>;
        importFailure?: Error;
    } = {},
) {
    const storage = options.storage ?? new Map<string, Map<string, Response>>();
    const failures = options.failures ?? new Set<string>();
    const listeners = new Map<string, (event: Event) => void>();
    const calls = {
        keys: 0,
        open: [] as string[],
        match: [] as Request[],
        put: [] as { request: Request; response: Response }[],
        delete: [] as string[],
        fetch: [] as { request: Request; init: RequestInit }[],
        skipWaiting: 0,
        claim: 0,
    };

    const fail = (operation: string) => {
        if (failures.has(operation)) {
            throw new Error(`${operation} failed`);
        }
    };

    const context = createContext({
        importScripts(path: string) {
            assert.equal(path, "/victor-cache.js");

            if (options.importFailure) {
                throw options.importFailure;
            }

            runInContext(helperSource, context, { filename: path });
        },
        URL,
        Response,
        self: {
            location: { origin },
            addEventListener: (name: string, listener: (event: Event) => void) => {
                assert.equal(listeners.has(name), false, "one listener per event type");
                listeners.set(name, listener);
            },
            skipWaiting() {
                calls.skipWaiting++;

                return Promise.resolve();
            },
            clients: {
                claim() {
                    calls.claim++;

                    return Promise.resolve();
                },
            },
        },
        caches: {
            async keys() {
                calls.keys++;
                await options.keysGate;
                fail("keys");

                return [...storage.keys()];
            },
            async delete(name: string) {
                calls.delete.push(name);
                fail(`delete:${name}`);

                return storage.delete(name);
            },
            async open(name: string) {
                calls.open.push(name);
                fail("open");
                let entries = storage.get(name);

                if (!entries) {
                    entries = new Map();
                    storage.set(name, entries);
                }

                const opened = entries;

                return {
                    async match(input: Request) {
                        calls.match.push(input);
                        fail("match");

                        return opened.get(input.url)?.clone();
                    },
                    async put(input: Request, response: Response) {
                        calls.put.push({ request: input, response });
                        await options.putGate;
                        fail("put");
                        const bytes = await response.arrayBuffer();

                        opened.set(
                            input.url,
                            new Response(bytes, {
                                status: response.status,
                                statusText: response.statusText,
                                headers: response.headers,
                            }),
                        );
                    },
                };
            },
        },
        async fetch(input: Request, init: RequestInit) {
            calls.fetch.push({ request: input, init });

            return options.network
                ? options.network(input)
                : new Response(`fixture:${input.url}`, {
                      headers: {
                          "content-type": "application/octet-stream",
                          "cache-control": "public, max-age=31536000, immutable",
                          etag: '"pinned"',
                          "cross-origin-resource-policy": "same-origin",
                      },
                  });
        },
    });

    runInContext(source, context, { filename: "web/sw.js" });

    function dispatch(input = request(), type = "fetch") {
        const lifetimes: Promise<unknown>[] = [];
        let response: Promise<Response> | undefined;
        let dispatching = true;

        listeners.get(type)!({
            request: input,
            respondWith(value) {
                assert.ok(dispatching, "respondWith must run synchronously during dispatch");
                assert.equal(response, undefined, "respondWith must run only once");
                response = Promise.resolve(value);
            },
            waitUntil(work) {
                lifetimes.push(Promise.resolve(work));
            },
        });

        dispatching = false;

        return {
            response,
            lifetimes,
            done: async () => {
                await Promise.all(lifetimes);
            },
        };
    }

    return { storage, calls, listeners, dispatch, context };
}

async function fetchAsset(w: ReturnType<typeof worker>, input = request()) {
    const event = w.dispatch(input);

    assert.ok(event.response, "a versioned victor asset must be intercepted");
    const response = await event.response;

    await event.done();

    return response;
}

function seeded(...names: string[]): Storage {
    return new Map(names.map((name) => [name, new Map([[asset(), new Response(name)]])]));
}

test("the imported helper exposes only its synchronous dispatcher and keeps cache state private", () => {
    const { context } = worker();

    assert.equal(
        runInContext("Object.keys(self.pocketVictorCache).join(',')", context),
        "handleFetch",
    );

    for (const name of [
        "victorCaches",
        "victorBundles",
        "victorCacheSetup",
        "openVictorCache",
        "victorAsset",
    ]) {
        assert.equal(runInContext(`typeof ${name}`, context), "undefined", name);
    }
});

test("helper loading errors fail worker evaluation rather than installing a partial worker", () => {
    const error = new SyntaxError("broken helper");

    assert.throws(
        () => worker({ importFailure: error }),
        (caught) => caught === error,
    );
});

test("victor cache does no install/activate work and keeps existing service-worker handlers", async () => {
    const w = worker();

    w.dispatch(request(), "install");
    await w.dispatch(request(), "activate").done();
    assert.equal(w.calls.skipWaiting, 1);
    assert.equal(w.calls.claim, 1);
    assert.ok(w.listeners.has("push"));
    assert.ok(w.listeners.has("notificationclick"));
    assert.equal(w.calls.keys, 0);
    assert.equal(w.calls.open.length, 0);
    assert.equal(w.calls.fetch.length, 0);
});

test("victor miss bypasses HTTP cache, stores a clone, and hits preserve bytes and headers", async () => {
    const network = new Response(new Uint8Array([0, 127, 255]), {
        headers: {
            "content-type": "application/wasm",
            "content-length": "3",
            etag: '"wasm-pin"',
            "cache-control": "public, max-age=31536000, immutable",
        },
    });
    const w = worker({ network: async () => network });
    const input = request();
    const first = w.dispatch(input);
    const cold = await first.response!;

    assert.equal(cold, network);
    assert.equal(w.calls.fetch.length, 1);
    assert.equal(w.calls.fetch[0]!.request, input);
    assert.equal(w.calls.fetch[0]!.init.cache, "no-store");
    assert.equal(first.lifetimes.length, 1);
    assert.notEqual(w.calls.put[0]!.response, network);
    assert.equal(w.calls.put[0]!.request, input);
    assert.deepEqual(new Uint8Array(await cold.arrayBuffer()), new Uint8Array([0, 127, 255]));
    await first.done();
    const warm = await fetchAsset(w);

    assert.deepEqual(new Uint8Array(await warm.arrayBuffer()), new Uint8Array([0, 127, 255]));
    assert.deepEqual([...warm.headers], [...network.headers]);
    assert.equal(w.calls.fetch.length, 1);
    assert.equal(w.calls.put.length, 1);
    assert.deepEqual(w.calls.open, [cacheName]);
    assert.equal(w.calls.keys, 1);
    const restarted = worker({ storage: w.storage });

    assert.deepEqual(
        new Uint8Array(await (await fetchAsset(restarted)).arrayBuffer()),
        new Uint8Array([0, 127, 255]),
    );
    assert.equal(restarted.calls.fetch.length, 0, "worker restart must retain completed entries");
});

test("victor requests preserve headers, credentials, nested paths and query-specific cache keys", async () => {
    const w = worker();
    const url = asset("tts/pronunciation.data");
    const first = request(`${url}?pin=1`, {
        credentials: "same-origin",
        headers: { authorization: "Bearer fixture" },
    });

    await fetchAsset(w, first);
    await fetchAsset(w, request(`${url}?pin=1`));
    await fetchAsset(w, request(`${url}?pin=2`));
    assert.equal(w.calls.fetch.length, 2);
    assert.equal(w.calls.fetch[0]!.request, first);
    assert.equal(w.calls.fetch[0]!.request.credentials, "same-origin");
    assert.equal(w.calls.fetch[0]!.request.headers.get("authorization"), "Bearer fixture");
    assert.deepEqual([...w.storage.get(cacheName)!.keys()], [`${url}?pin=1`, `${url}?pin=2`]);
});

test("manifest, app, API, uploads, foreign origins and unsafe victor requests are untouched", () => {
    const w = worker();
    const urls = [
        "/",
        "/sw.js",
        "/victor-worker.js",
        "/app.js",
        "/api/events",
        "/uploads/1/model.onnx",
        "/victor-assets",
        "/victor-assets/",
        "/victor-assets/manifest.json",
        "/victor-assets/manifest.json?version=1",
        `/victor-assets/${bundle}`,
        `/victor-assets/${bundle}/`,
        `/victor-assets//${bundle}/encoder.onnx`,
        `/victor-assets-extra/${bundle}/encoder.onnx`,
        `/other/victor-assets/${bundle}/encoder.onnx`,
        "/victor-assets/%2Fescape/encoder.onnx",
        "/victor-assets/../api/events",
        asset().replace(origin, "https://elsewhere.test"),
        asset().replace(origin, "https://pocket.test:8443"),
        asset().replace(origin, "http://pocket.test"),
    ];

    for (const url of urls) {
        const event = w.dispatch(request(new URL(url, origin).href));

        assert.equal(event.response, undefined, url);
        assert.equal(event.lifetimes.length, 0, url);
    }

    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"]) {
        assert.equal(w.dispatch(request(asset(), { method })).response, undefined, method);
    }

    assert.equal(
        w.dispatch(request(asset(), { headers: { range: "bytes=0-31" } })).response,
        undefined,
        "range requests must not receive a cached full response",
    );
    assert.equal(w.calls.keys, 0);
    assert.equal(w.calls.open.length, 0);
    assert.equal(w.calls.fetch.length, 0);
});

test("unsuccessful, partial and redirected responses are returned without caching", async () => {
    const redirected = new Response("a sign-in page");

    Object.defineProperties(redirected, {
        redirected: { value: true },
        url: { value: `${origin}/login` },
    });
    const responses = [
        new Response("missing", { status: 404 }),
        new Response("unavailable", { status: 503 }),
        new Response(null, { status: 304 }),
        new Response("partial", { status: 206 }),
        redirected,
        Response.error(),
    ];
    const w = worker({ network: async () => responses.shift()! });

    for (let i = 0; i < 6; i++) {
        const expected = responses[0];
        const event = w.dispatch(request(asset(`failed-${i}.onnx`)));

        assert.equal(await event.response!, expected);
        await event.done();
        assert.equal(event.lifetimes.length, 0);
    }

    assert.equal(w.calls.fetch.length, 6);
    assert.equal(w.calls.put.length, 0);
    assert.equal(w.storage.get(cacheName)!.size, 0);
});

test("a pending or quota-failed cache write never delays or rejects the network response", async () => {
    const write = Promise.withResolvers<void>();
    const network = new Response("usable network bytes");
    const w = worker({
        network: async () => network,
        putGate: write.promise,
        failures: new Set(["put"]),
    });
    const event = w.dispatch();
    const response = await event.response!;

    assert.equal(response, network);
    assert.equal(await response.text(), "usable network bytes");
    assert.equal(event.lifetimes.length, 1);
    assert.equal(w.storage.get(cacheName)!.size, 0);
    write.resolve();
    await event.done();
    await settle();
    assert.equal(w.storage.get(cacheName)!.size, 0);
});

test("cache cloning failure still returns the original network response", async () => {
    const network = new Response("usable bytes");

    network.clone = () => {
        throw new Error("clone failed");
    };

    const w = worker({ network: async () => network });

    assert.equal(await (await fetchAsset(w)).text(), "usable bytes");
    assert.equal(w.calls.put.length, 0);
});

test("Cache Storage open and read failures fall back to a cache-bypassing network fetch", async (t) => {
    for (const failure of ["open", "match"]) {
        await t.test(failure, async () => {
            const w = worker({ storage: seeded(cacheName), failures: new Set([failure]) });
            const response = await fetchAsset(w);

            assert.equal(await response.text(), `fixture:${asset()}`);
            assert.equal(w.calls.fetch.length, 1);
            assert.equal(w.calls.fetch[0]!.init.cache, "no-store");
            assert.equal(w.calls.put.length, failure === "open" ? 0 : 1);
            await settle();
        });
    }
});

test("a temporary cache-open failure retries opening without repeating bundle cleanup", async () => {
    const failures = new Set(["open"]);
    const w = worker({ failures, storage: seeded("pocket-victor-old", "pocket-share") });
    const events = [w.dispatch(), w.dispatch(request(asset("decoder.onnx")))];

    await Promise.all(events.map((event) => event.response));
    await Promise.all(events.map((event) => event.done()));
    assert.deepEqual(w.calls.open, [cacheName]);
    assert.equal(w.calls.keys, 1);
    assert.equal(w.calls.fetch.length, 2);
    assert.equal(w.calls.put.length, 0);
    failures.delete("open");
    await fetchAsset(w);
    await fetchAsset(w);
    assert.deepEqual(w.calls.open, [cacheName, cacheName]);
    assert.equal(w.calls.keys, 1, "retrying open must not repeat cleanup");
    assert.equal(w.calls.fetch.length, 3, "the recovered cache supplies the next request");
    assert.ok(w.storage.has("pocket-share"));
});

test("cleanup failures are best effort and do not skip unrelated old victor-cache deletions", async (t) => {
    for (const failure of ["keys", "delete:pocket-victor-old"]) {
        await t.test(failure, async () => {
            const w = worker({
                storage: seeded("pocket-victor-old", "pocket-victor-older", "pocket-share"),
                failures: new Set([failure]),
            });

            assert.equal(await (await fetchAsset(w)).text(), `fixture:${asset()}`);
            assert.ok(w.storage.has("pocket-share"));
            assert.ok(w.storage.has(cacheName));

            if (failure !== "keys") {
                assert.ok(w.storage.has("pocket-victor-old"));
                assert.equal(w.storage.has("pocket-victor-older"), false);
            }

            await settle();
        });
    }
});

test("an interrupted partial bundle retains completed assets and retries only missing assets", async () => {
    let failMissing = true;

    const network = async (input: Request) => {
        if (input.url === asset("decoder.onnx") && failMissing) {
            failMissing = false;

            throw new Error("download interrupted");
        }

        return new Response(`fixture:${input.url}`);
    };

    const w = worker({ network });

    await fetchAsset(w);
    const interrupted = w.dispatch(request(asset("decoder.onnx")));

    assert.ok(interrupted.response);
    await assert.rejects(interrupted.response, /download interrupted/);
    await interrupted.done();
    assert.deepEqual([...w.storage.get(cacheName)!.keys()], [asset()]);
    const restarted = worker({ network, storage: w.storage });

    assert.equal(await (await fetchAsset(restarted)).text(), `fixture:${asset()}`);
    await fetchAsset(restarted, request(asset("decoder.onnx")));
    assert.deepEqual(
        restarted.calls.fetch.map((call) => call.request.url),
        [asset("decoder.onnx")],
    );
    assert.equal(w.storage.get(cacheName)!.size, 2);
});

test("an interrupted pronunciation pack retries its whole body and a new bundle replaces it", async () => {
    const path = "tts/pronunciation.data";
    const bytes = new Uint8Array([0, 255, 13, 10, 42, 128, 1]);
    const interrupted = Promise.withResolvers<void>();
    const w = worker({
        network: async () =>
            new Response(
                new ReadableStream({
                    async start(controller) {
                        controller.enqueue(bytes.subarray(0, 3));
                        await interrupted.promise;
                        controller.error(new Error("pack body interrupted"));
                    },
                }),
            ),
    });

    const event = w.dispatch(request(asset(path)));
    const response = await event.response!;
    const body = response.arrayBuffer();

    interrupted.resolve();
    await assert.rejects(body, /pack body interrupted/);
    await event.done();
    assert.equal(w.storage.get(cacheName)!.has(asset(path)), false);
    const restarted = worker({ storage: w.storage, network: async () => new Response(bytes) });
    const complete = await fetchAsset(restarted, request(asset(path)));

    assert.deepEqual(new Uint8Array(await complete.arrayBuffer()), bytes);
    assert.equal(restarted.calls.fetch.length, 1);
    assert.equal(restarted.calls.fetch[0]!.request.headers.get("range"), null);
    const warm = await fetchAsset(restarted, request(asset(path)));

    assert.deepEqual(new Uint8Array(await warm.arrayBuffer()), bytes);
    assert.equal(restarted.calls.fetch.length, 1);
    const nextBundle = `victor-${"b".repeat(64)}`;

    await fetchAsset(restarted, request(asset(path, nextBundle)));
    assert.deepEqual([...w.storage.keys()], [`pocket-victor-${nextBundle}`]);
    assert.equal(restarted.calls.fetch.length, 2, "a new bundle downloads the whole pack again");
});

test("first request per bundle removes only other victor caches and preserves the current partial", async () => {
    const unrelated = ["pocket-share", "app-fixtures", "pocket-victor", "other-pocket-victor-old"];
    const w = worker({ storage: seeded(cacheName, "pocket-victor-old", ...unrelated) });

    assert.equal(await (await fetchAsset(w)).text(), cacheName);
    assert.equal(w.calls.fetch.length, 0);
    assert.deepEqual(w.calls.delete, ["pocket-victor-old"]);
    await fetchAsset(w, request(asset("decoder.onnx")));
    assert.equal(w.calls.keys, 1, "cleanup must not repeat for every asset");
    const nextName = "pocket-victor-test-bundle-2";

    await fetchAsset(w, request(asset("encoder.onnx", "test-bundle-2")));
    assert.deepEqual(new Set(w.storage.keys()), new Set([...unrelated, nextName]));
    assert.deepEqual(w.calls.delete, ["pocket-victor-old", cacheName]);
    assert.equal(w.calls.keys, 2);
});

test("concurrent assets share a single bundle setup, including when cleanup fails", async () => {
    const cleanup = Promise.withResolvers<void>();
    const w = worker({
        storage: seeded("pocket-victor-old", "pocket-share"),
        keysGate: cleanup.promise,
        failures: new Set(["delete:pocket-victor-old"]),
    });
    const events = Array.from({ length: 12 }, (_, i) =>
        w.dispatch(request(asset(`tts/pronunciation-${i}`))),
    );

    await settle();
    assert.equal(w.calls.keys, 1);
    assert.equal(w.calls.open.length, 0);
    cleanup.resolve();
    await Promise.all(events.map((event) => event.response));
    await Promise.all(events.map((event) => event.done()));
    await settle();
    assert.equal(w.calls.keys, 1);
    assert.deepEqual(w.calls.open, [cacheName]);
    assert.equal(w.storage.get(cacheName)!.size, 12);
    assert.ok(w.storage.has("pocket-share"));
});

test("concurrent bundles serialize cleanup/opening and old in-flight writes cannot resurrect caches", async () => {
    const writes = Promise.withResolvers<void>();
    const w = worker({
        storage: seeded("pocket-victor-old", "pocket-share"),
        putGate: writes.promise,
    });
    const versions = ["test-bundle-1", "test-bundle-2", "test-bundle-3"];
    const events = versions.map((version) => w.dispatch(request(asset("encoder.onnx", version))));

    await Promise.all(events.map((event) => event.response));
    assert.deepEqual(
        w.calls.open,
        versions.map((version) => `pocket-victor-${version}`),
    );
    assert.deepEqual([...w.storage.keys()], ["pocket-share", "pocket-victor-test-bundle-3"]);
    writes.resolve();
    await Promise.all(events.map((event) => event.done()));
    assert.deepEqual([...w.storage.keys()], ["pocket-share", "pocket-victor-test-bundle-3"]);
    await fetchAsset(w, request(asset("decoder.onnx", "test-bundle-1")));
    assert.equal(w.calls.keys, 3);
    assert.equal(w.calls.open.length, 3);
    assert.deepEqual([...w.storage.keys()], ["pocket-share", "pocket-victor-test-bundle-3"]);
});
