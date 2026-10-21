import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { HttpError } from "../src/server/errors.ts";
import { serveApp, serveFile, WEB } from "../src/server/http/assets.ts";
import { createVictorAssetHandler } from "../src/server/http/victor-assets.ts";

async function fixture(t: TestContext) {
    const root = mkdtempSync(join(tmpdir(), "victor-http-"));
    const handler = createVictorAssetHandler(root);
    const body = Buffer.alloc(1024 * 1024, 42);
    const hash = createHash("sha256").update(body).digest("hex");
    const source = JSON.parse(
        readFileSync(new URL("../victor-sources.json", import.meta.url), "utf8"),
    );
    const bundle = "victor-" + "a".repeat(64);
    const manifest = {
        schemaVersion: 2,
        bundle,
        bundleBase: `/victor-assets/${bundle}/`,
        runtime: source.runtime,
        model: source.model,
        tts: {
            ...source.tts,
            pronunciation: {
                asset: "tts/pronunciation.data",
                files: [
                    { path: "en_dict", offset: 0, bytes: 1 },
                    { path: "voices/!v/Mr serious?#", offset: 1, bytes: body.length - 1 },
                ],
            },
        },
        sources: source.sources,
        assets: [
            ...source.assets.map((asset: { name: string; contentType: string }) => ({
                name: asset.name,
                bytes: body.length,
                sha256: hash,
                contentType: asset.contentType,
            })),
            {
                name: "tts/pronunciation.data",
                bytes: body.length,
                sha256: hash,
                contentType: "application/octet-stream",
            },
        ],
    };
    const file = join(root, "vendor", "victor", manifest.bundle, hash);

    mkdirSync(join(root, "vendor", "victor", manifest.bundle), { recursive: true });
    writeFileSync(file, body);
    const save = (value: unknown = manifest) =>
        writeFileSync(join(root, "vendor", "victor", "manifest.json"), JSON.stringify(value));
    const server = createServer(async (req, res) => {
        try {
            if (req.url === "/") {
                serveApp(res);
            } else if (
                req.url === "/victor-worker.js" ||
                req.url === "/victor-capture-worklet.js" ||
                req.url === "/voice.js"
            ) {
                await serveFile(req, res, join(WEB, req.url));
            } else {
                handler(req, res, req.url!);
            }
        } catch (error) {
            res.writeHead(error instanceof HttpError ? error.status : 500);
            res.end((error as Error).message);
        }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    });
    const address = server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;

    return {
        root,
        manifest,
        body,
        file,
        save,
        base,
        request: (path: string, init?: RequestInit) => fetch(base + path, init),
    };
}

test("underscore asset filename segments remain valid", async (t) => {
    const f = await fixture(t);

    f.manifest.assets[0]!.name = "_runtime.js";
    f.manifest.runtime.script = "_runtime.js";
    f.save();
    const response = await f.request(f.manifest.bundleBase + "_runtime.js");

    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.body);
});

test("missing and malformed optional manifest leave app available and retry after repair", async (t) => {
    const f = await fixture(t);
    const app = await f.request("/");

    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-security-policy")!, /'wasm-unsafe-eval'/);
    const worker = await f.request("/victor-worker.js");

    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.match(worker.headers.get("content-security-policy")!, /worker-src 'none'/);

    // The obsolete root manifest is never a fallback for missing generated output.
    writeFileSync(join(f.root, "victor-assets.json"), JSON.stringify(f.manifest));

    for (const broken of [undefined, "{", "null"]) {
        if (broken !== undefined) {
            writeFileSync(join(f.root, "vendor", "victor", "manifest.json"), broken);
        }

        const response = await f.request("/victor-assets/manifest.json");

        assert.equal(response.status, 503);
        assert.match(await response.text(), /^Victor manifest is unavailable/);
    }

    assert.equal((await f.request("/victor-assets/manifest.json", { method: "POST" })).status, 405);
    f.save();
    assert.equal((await f.request("/victor-assets/manifest.json")).status, 200);
    writeFileSync(join(f.root, "vendor", "victor", "manifest.json"), "broken again");
    assert.equal((await f.request("/victor-assets/manifest.json")).status, 200);
});

/** Compare Content-Length with encoded wire bytes, not fetch's automatically decoded body. */
function wireRequest(url: string, method: string, accept?: string) {
    return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: Buffer }>(
        (resolve, reject) => {
            get(
                url,
                {
                    method,
                    headers: accept === undefined ? {} : { "accept-encoding": accept },
                    signal: AbortSignal.timeout(5000),
                },
                (response) => {
                    const chunks: Buffer[] = [];

                    response.on("data", (chunk: Buffer) => chunks.push(chunk));
                    response.on("error", reject);
                    response.on("end", () =>
                        resolve({
                            status: response.statusCode,
                            headers: response.headers,
                            body: Buffer.concat(chunks),
                        }),
                    );
                },
            ).on("error", reject);
        },
    );
}

test("manifest GET negotiates compression and HEAD describes the same representation without a body", async (t) => {
    const f = await fixture(t);

    f.save();
    const plain = Buffer.from(JSON.stringify(f.manifest));
    const url = f.base + "/victor-assets/manifest.json";

    for (const [accept, encoding] of [
        [undefined, undefined],
        ["identity", undefined],
        ["gzip", "gzip"],
        ["br", "br"],
        ["gzip, br", "br"],
        ["gzip;q=0, br;q=0", undefined],
    ] as const) {
        const response = await wireRequest(url, "GET", accept);
        const head = await wireRequest(url, "HEAD", accept);

        for (const result of [response, head]) {
            assert.equal(result.status, 200);
            assert.equal(result.headers["content-encoding"], encoding);
            assert.equal(result.headers["cache-control"], "no-cache");
            assert.equal(result.headers["content-type"], "application/json");
            assert.equal(result.headers["cross-origin-resource-policy"], "same-origin");

            // A length may be omitted. If present, it describes wire bytes, not decoded JSON.
            if (result.headers["content-length"] !== undefined) {
                assert.equal(Number(result.headers["content-length"]), response.body.length);
            }

            if (encoding !== undefined) {
                assert.match(result.headers.vary!, /\baccept-encoding\b/i);
            }
        }

        assert.equal(head.body.length, 0);
        assert.equal(head.headers.vary, response.headers.vary);
        const decoded =
            encoding === "br"
                ? brotliDecompressSync(response.body)
                : encoding === "gzip"
                  ? gunzipSync(response.body)
                  : response.body;

        assert.deepEqual(decoded, plain);
        assert.deepEqual(JSON.parse(decoded.toString("utf8")), f.manifest);

        if (encoding !== undefined) {
            assert.ok(response.body.length < plain.length);
        }
    }
});

test("compressed and revalidated worker scripts keep their dedicated security policies", async (t) => {
    const f = await fixture(t);

    for (const file of ["victor-worker.js", "victor-capture-worklet.js", "voice.js"]) {
        const expected = readFileSync(join(WEB, file), "utf8");

        for (const encoding of ["identity", "gzip", "br"]) {
            const response = await f.request(`/${file}`, {
                headers: { "accept-encoding": encoding },
            });

            assert.equal(response.status, 200);
            assert.equal(await response.text(), expected);
            assert.equal(response.headers.get("cache-control"), "no-cache");
            assert.equal(
                response.headers.get("content-encoding"),
                encoding === "identity" ? null : encoding,
            );
            const etag = response.headers.get("etag");

            assert.ok(etag);
            const cached = await f.request(`/${file}`, {
                headers: { "accept-encoding": encoding, "if-none-match": etag },
            });

            assert.equal(cached.status, 304);
            assert.equal(await cached.text(), "");

            for (const result of [response, cached]) {
                if (file === "voice.js") {
                    assert.equal(result.headers.get("content-security-policy"), null);
                    assert.equal(result.headers.get("cross-origin-resource-policy"), null);
                } else {
                    assert.match(
                        result.headers.get("content-security-policy")!,
                        /worker-src 'none'/,
                    );
                    assert.match(
                        result.headers.get("content-security-policy")!,
                        /'wasm-unsafe-eval'/,
                    );
                    assert.equal(result.headers.get("cross-origin-resource-policy"), "same-origin");
                }
            }
        }
    }
});

test("invalid layouts and asset fields fail closed and can be repaired", async (t) => {
    const f = await fixture(t);
    const asset = f.manifest.assets[0]!;
    const invalid = [
        { ...f.manifest, bundle: "../escape" },
        { ...f.manifest, bundle: "_test-v1", bundleBase: "/victor-assets/_test-v1/" },
        { ...f.manifest, bundleBase: "/elsewhere/" },
        { ...f.manifest, schemaVersion: 1 },
        { ...f.manifest, assets: [] },
        { ...f.manifest, assets: [asset, ...f.manifest.assets.slice(0, -1)] },
        ...["../secret", "/secret", "nested//file", "nested/./file", "a\\b", "%2e%2e/secret"].map(
            (name) => ({
                ...f.manifest,
                assets: [{ ...asset, name }, ...f.manifest.assets.slice(1)],
            }),
        ),
        ...[
            { bytes: -1 },
            { bytes: 1.5 },
            { sha256: "../secret" },
            { contentType: "text/plain\r\nx: y" },
        ].map((change) => ({
            ...f.manifest,
            assets: [{ ...asset, ...change }, ...f.manifest.assets.slice(1)],
        })),
    ];

    for (const value of invalid) {
        f.save(value);
        const response = await f.request("/victor-assets/manifest.json");

        assert.equal(response.status, 503, JSON.stringify(value));
        assert.ok(!(await response.text()).includes(f.root));
    }

    f.save();
    assert.equal((await f.request(f.manifest.bundleBase + "unknown")).status, 404);
    assert.equal((await f.request(f.manifest.bundleBase + asset.sha256)).status, 404);
});

test("schema-2 configuration and complete pronunciation index are validated before serving", async (t) => {
    const f = await fixture(t);
    const changes: ((value: typeof f.manifest) => void)[] = [
        (m) => {
            m.runtime.script = "missing.js";
        },
        (m) => {
            m.model.sampleRate = 0;
        },
        (m) => {
            m.model.featureDim = 1.5;
        },
        (m) => {
            m.model.type = "unsupported";
        },
        (m) => {
            m.tts.sampleRate = 16000;
        },
        (m) => {
            m.tts.dataDir = "outside";
        },
        (m) => {
            m.tts.dataDir = "tts/model.onnx";
        },
        (m) => {
            m.tts.dataDir = "tts/model.onnx/child";
        },
        (m) => {
            m.tts.pronunciation.asset = "tts/old.data";
        },
        (m) => {
            m.tts.pronunciation.files = [];
        },
        (m) => {
            m.tts.pronunciation.files[1]!.offset = 0;
        },
        (m) => {
            m.tts.pronunciation.files[1]!.offset = 2;
        },
        (m) => {
            m.tts.pronunciation.files[1]!.bytes--;
        },
        (m) => {
            m.tts.pronunciation.files[1]!.bytes++;
        },
        (m) => {
            m.tts.pronunciation.files[0]!.bytes = -1;
        },
        (m) => {
            m.tts.pronunciation.files[0]!.bytes = 0.5;
        },
        (m) => {
            m.tts.pronunciation.files[1]!.bytes = Number.MAX_SAFE_INTEGER;
        },
        (m) => {
            m.tts.pronunciation.files[1]!.path = "en_dict";
        },
        (m) => {
            m.tts.pronunciation.files[1]!.path = "en_dict/child";
        },
        (m) => {
            m.tts.pronunciation.files.reverse();
        },
        ...["../escape", "/absolute", "a\\b", "a//b", "a/./b", "a/../b"].map(
            (path) => (m: typeof f.manifest) => {
                m.tts.pronunciation.files[0]!.path = path;
            },
        ),
        ...["en_dict", "en_dict/child"].map((path) => (m: typeof f.manifest) => {
            const asset = m.assets.find((asset) => asset.name === m.tts.model)!;

            m.tts.model = m.tts.dataDir + "/" + path;
            asset.name = m.tts.model;
        }),
    ];

    for (const change of changes) {
        const value = structuredClone(f.manifest);

        change(value);
        f.save(value);
        assert.equal(
            (await f.request("/victor-assets/manifest.json")).status,
            503,
            JSON.stringify(value),
        );
    }

    f.save();
    const response = await f.request("/victor-assets/manifest.json");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), f.manifest);
    assert.equal(
        (await f.request(f.manifest.bundleBase + "tts/espeak-ng-data/en_dict")).status,
        404,
    );
    assert.equal((await f.request(f.manifest.bundleBase + "tts/pronunciation.data")).status, 200);
});

test("manifest and streamed assets preserve headers, HEAD, ETags, errors and disconnects", async (t) => {
    const f = await fixture(t);

    f.save();
    const path = f.manifest.bundleBase + "tts/pronunciation.data";
    const manifest = await f.request("/victor-assets/manifest.json", { method: "HEAD" });

    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("cache-control"), "no-cache");
    assert.equal(await manifest.text(), "");
    const response = await f.request(path);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-security-policy")!, /connect-src 'self'/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.body);
    const head = await f.request(path, { method: "HEAD" });

    assert.equal(head.headers.get("content-length"), String(f.body.length));
    assert.equal(await head.text(), "");
    const cached = await f.request(path, {
        headers: { "if-none-match": response.headers.get("etag")! },
    });

    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
    const post = await f.request(path, { method: "POST" });

    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
    await new Promise<void>((resolve, reject) => {
        get(f.base + path, (res) => {
            res.once("data", () => {
                res.destroy();
                resolve();
            });
            res.on("error", reject);
        }).on("error", reject);
    });
    assert.equal((await f.request(path, { method: "HEAD" })).status, 200);
    writeFileSync(f.file, "partial");
    assert.equal((await f.request(path)).status, 503);
    rmSync(f.file);
    assert.equal((await f.request(path)).status, 503);
});
