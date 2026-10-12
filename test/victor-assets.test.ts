// Preparation tests copy only the CLI into throwaway checkouts and serve tiny pinned archives.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

type SourceId = "runtime" | "model" | "tts";
type Source = { url: string; sha256: string; revision?: string };
type DirectAsset = { name: string; source: SourceId; member: string; contentType: string };
type SourceSpec = {
    schemaVersion: number;
    runtime: { script: string; wrapper: string; wasm: string; ttsWrapper: string };
    model: {
        type: string;
        encoder: string;
        decoder: string;
        joiner: string;
        tokens: string;
        sampleRate: number;
        featureDim: number;
    };
    tts: {
        type: string;
        model: string;
        voices: string;
        tokens: string;
        dataDir: string;
        sampleRate: number;
        pronunciation: { source: SourceId; prefix: string };
    };
    sources: Record<SourceId, Source>;
    assets: DirectAsset[];
};
type ManifestAsset = { name: string; bytes: number; sha256: string; contentType: string };
type Manifest = {
    schemaVersion: number;
    runtime: SourceSpec["runtime"];
    model: SourceSpec["model"];
    tts: Omit<SourceSpec["tts"], "pronunciation"> & {
        pronunciation: {
            asset: string;
            files: { path: string; offset: number; bytes: number }[];
        };
    };
    sources: SourceSpec["sources"];
    assets: ManifestAsset[];
    bundle: string;
    bundleBase: string;
};
type TarEntry = {
    path: string;
    bytes?: Buffer;
    type?: "0" | "1" | "2" | "5" | "6";
    link?: string;
    mtime?: number;
};
type CliResult = { code: number | string | null; stdout: string; stderr: string };

const exec = promisify(execFile);
const ids: SourceId[] = ["runtime", "model", "tts"];
const prefix = "kitten-micro-en-v0_8/espeak-ng-data/";
const octetStream = "application/octet-stream";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const lexical = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

// Hand-written ustar preserves dangerous names and links that a normal tar creator may sanitize.
function archive(entries: TarEntry[]) {
    const blocks: Buffer[] = [];

    for (const entry of entries) {
        const header = Buffer.alloc(512);
        const bytes = entry.bytes ?? Buffer.alloc(0);

        const field = (offset: number, length: number, value: string) => {
            assert.ok(Buffer.byteLength(value) < length, `ustar fixture field: ${value}`);
            header.write(value, offset, length, "utf8");
        };

        const octal = (offset: number, length: number, value: number) =>
            field(offset, length, value.toString(8).padStart(length - 1, "0"));

        field(0, 100, entry.path);
        octal(100, 8, entry.type === "5" ? 0o755 : 0o644);
        octal(108, 8, 0);
        octal(116, 8, 0);
        octal(124, 12, bytes.length);
        octal(136, 12, entry.mtime ?? 1);
        header.fill(0x20, 148, 156);
        header.write(entry.type ?? "0", 156);
        field(157, 100, entry.link ?? "");
        field(257, 6, "ustar");
        header.write("00", 263);
        field(265, 32, "fixture");
        field(297, 32, "fixture");

        const checksum = header.reduce((sum, byte) => sum + byte, 0);

        header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
        blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }

    blocks.push(Buffer.alloc(1024));

    return gzipSync(Buffer.concat(blocks));
}

function makeSpec(url: string): SourceSpec {
    const runtime = {
        script: "sherpa-onnx-wasm-web.js",
        wrapper: "sherpa-onnx-asr.js",
        wasm: "sherpa-onnx-wasm-web.wasm",
        ttsWrapper: "sherpa-onnx-tts.js",
    };
    const model = {
        type: "zipformer2",
        encoder: "encoder.onnx",
        decoder: "decoder.onnx",
        joiner: "joiner.onnx",
        tokens: "tokens.txt",
        sampleRate: 16000,
        featureDim: 80,
    };
    const tts = {
        type: "kitten",
        model: "tts/model.onnx",
        voices: "tts/voices.bin",
        tokens: "tts/tokens.txt",
        dataDir: "tts/espeak-ng-data",
        sampleRate: 24000,
        pronunciation: { source: "tts" as const, prefix },
    };
    const assets: DirectAsset[] = [
        ...Object.values(runtime).map((name) => ({
            name,
            source: "runtime" as const,
            member: `assets/${name}`,
            contentType: name.endsWith(".wasm")
                ? "application/wasm"
                : "text/javascript; charset=utf-8",
        })),
        ...[model.encoder, model.decoder, model.joiner, model.tokens].map((name) => ({
            name,
            source: "model" as const,
            member: `asr-model/${name}`,
            contentType: name.endsWith(".txt") ? "text/plain; charset=utf-8" : octetStream,
        })),
        ...[tts.model, tts.voices, tts.tokens].map((name) => ({
            name,
            source: "tts" as const,
            member: `kitten-micro-en-v0_8/${name.slice(4)}`,
            contentType: octetStream,
        })),
    ];

    return {
        schemaVersion: 1,
        runtime,
        model,
        tts,
        sources: {
            runtime: { url: `${url}/runtime.tar.gz`, sha256: "", revision: "a".repeat(40) },
            model: { url: `${url}/model.tar.gz`, sha256: "" },
            tts: { url: `${url}/tts.tar.gz`, sha256: "" },
        },
        assets,
    };
}

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "pocket-victor-assets-"));
    const script = join(root, "scripts", "prepare-victor-assets.mjs");
    const cwd = join(root, "unrelated-working-directory");
    const directory = join(root, "vendor", "victor");
    const manifestPath = join(directory, "manifest.json");
    const archives = new Map<string, Buffer>();
    const requests: string[] = [];
    const server = createServer((request, response) => {
        const path = request.url ?? "";
        const bytes = archives.get(path);

        requests.push(path);

        if (!bytes) {
            response.writeHead(404).end();

            return;
        }

        response.writeHead(200, {
            "Content-Type": "application/gzip",
            "Content-Length": bytes.length,
        });
        response.end(bytes);
    });

    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
    });
    await mkdir(dirname(script), { recursive: true });
    await mkdir(cwd);
    await copyFile(new URL("../scripts/prepare-victor-assets.mjs", import.meta.url), script);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    assert.ok(address && typeof address !== "string");

    const spec = makeSpec(`http://127.0.0.1:${address.port}`);
    const entries: Record<SourceId, TarEntry[]> = { runtime: [], model: [], tts: [] };
    const direct = new Map<string, Buffer>();
    const pronunciation = new Map<string, Buffer>([
        ["voices/voice name ", Buffer.from("voice with a trailing space in its path")],
        ["lang/jpx/ja", Buffer.from([0, 255, 128, 7])],
        ["a_dict", Buffer.from("a dictionary")],
        ["voices/!v/whisper", Buffer.from("whisper")],
        ["lang/gmw/en", Buffer.from("English phonemes")],
        ["Z_dict", Buffer.from("uppercase sorts before lowercase")],
        ["en_dict", Buffer.from("English dictionary")],
    ]);

    for (const asset of spec.assets) {
        const bytes = Buffer.from(`${asset.name}\0fixture bytes\n`);

        direct.set(asset.name, bytes);
        entries[asset.source].push({ path: asset.member, bytes });
    }

    entries.tts.unshift({ path: prefix.slice(0, -1), type: "5" });

    for (const [path, bytes] of pronunciation) {
        entries.tts.push({ path: prefix + path, bytes });
    }

    for (const id of ids) {
        entries[id].push({ path: `unused-${id}/README`, bytes: Buffer.from("not an asset") });
    }

    const pin = (id: SourceId) => {
        const bytes = archive(entries[id]);

        archives.set(`/${id}.tar.gz`, bytes);
        spec.sources[id].sha256 = hash(bytes);
    };

    const save = () => writeFile(join(root, "victor-sources.json"), JSON.stringify(spec));

    const run = async (args: string[] = []): Promise<CliResult> => {
        try {
            const result = await exec(process.execPath, [script, ...args], {
                cwd,
                timeout: 30_000,
                maxBuffer: 1024 * 1024,
            });

            return { code: 0, ...result };
        } catch (error) {
            const result = error as Error & CliResult & { killed?: boolean; signal?: string };

            assert.ok(!result.killed && !result.signal, `CLI did not finish: ${result.message}`);

            return { code: result.code, stdout: result.stdout, stderr: result.stderr };
        }
    };

    const manifest = async () => JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;

    const readAsset = (value: Manifest, name: string) => {
        const asset = value.assets.find((asset) => asset.name === name);

        assert.ok(asset, `manifest asset ${name}`);

        return readFile(join(directory, value.bundle, asset.sha256));
    };

    for (const id of ids) {
        pin(id);
    }

    await save();

    return {
        root,
        script,
        directory,
        manifestPath,
        spec,
        entries,
        archives,
        requests,
        direct,
        pronunciation,
        pin,
        save,
        run,
        manifest,
        readAsset,
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function prepare(f: Fixture) {
    await f.save();

    const result = await f.run();

    assert.equal(result.code, 0, result.stderr + result.stdout);

    return f.manifest();
}

function downloadedAll(f: Fixture, start = 0) {
    assert.deepEqual(f.requests.slice(start).sort(), ids.map((id) => `/${id}.tar.gz`).sort());
}

async function assertClean(f: Fixture) {
    const names = await readdir(f.directory);

    assert.ok(
        names.every(
            (name) =>
                name === "manifest.json" ||
                name === ".prepared.json" ||
                /^victor-[a-f0-9]{64}$/.test(name),
        ),
    );
}

async function assertBundle(f: Fixture, manifest: Manifest) {
    const { bundle, bundleBase, ...payload } = manifest;
    const { pronunciation: _recipe, ...tts } = f.spec.tts;
    const expectedFiles: Manifest["tts"]["pronunciation"]["files"] = [];
    const chunks: Buffer[] = [];
    let offset = 0;

    for (const path of [...f.pronunciation.keys()].sort(lexical)) {
        const bytes = f.pronunciation.get(path)!;

        expectedFiles.push({ path, offset, bytes: bytes.length });
        chunks.push(bytes);
        offset += bytes.length;
    }

    const pack = Buffer.concat(chunks);
    const expectedAssets = [
        ...f.spec.assets.map((asset) => {
            const bytes = f.direct.get(asset.name)!;

            return {
                name: asset.name,
                bytes: bytes.length,
                sha256: hash(bytes),
                contentType: asset.contentType,
            };
        }),
        {
            name: "tts/pronunciation.data",
            bytes: pack.length,
            sha256: hash(pack),
            contentType: octetStream,
        },
    ].sort((left, right) => lexical(left.name, right.name));

    assert.equal(manifest.schemaVersion, 2);
    assert.equal(bundle, `victor-${hash(JSON.stringify(payload))}`);
    assert.equal(bundleBase, `/victor-assets/${bundle}/`);
    assert.deepEqual(manifest.runtime, f.spec.runtime);
    assert.deepEqual(manifest.model, f.spec.model);
    assert.deepEqual(manifest.tts, {
        ...tts,
        pronunciation: { asset: "tts/pronunciation.data", files: expectedFiles },
    });
    assert.deepEqual(manifest.sources, f.spec.sources);
    assert.deepEqual(manifest.assets, expectedAssets);
    assert.deepEqual(await f.readAsset(manifest, "tts/pronunciation.data"), pack);
    assert.deepEqual(
        (await readdir(join(f.directory, bundle))).sort(),
        expectedAssets.map((a) => a.sha256).sort(),
    );

    for (const asset of expectedAssets) {
        const bytes = await f.readAsset(manifest, asset.name);

        assert.equal(bytes.length, asset.bytes);
        assert.equal(hash(bytes), asset.sha256);
    }

    await assertClean(f);
}

function changedAssets(before: Manifest, after: Manifest) {
    return after.assets
        .filter(
            (asset) =>
                before.assets.find((previous) => previous.name === asset.name)?.sha256 !==
                asset.sha256,
        )
        .map((asset) => asset.name);
}

test("Victor preparation builds a deterministic 12-blob manifest and byte-exact lexical pronunciation pack", async (t) => {
    const f = await fixture(t);
    const first = await prepare(f);
    const firstText = await readFile(f.manifestPath);

    downloadedAll(f);
    await assertBundle(f, first);

    // Object and recipe ordering are not model inputs; output uses the builder's fixed field order.
    f.spec.assets.reverse();
    f.spec.runtime = Object.fromEntries(
        Object.entries(f.spec.runtime).reverse(),
    ) as SourceSpec["runtime"];
    f.spec.model = Object.fromEntries(
        Object.entries(f.spec.model).reverse(),
    ) as SourceSpec["model"];
    f.spec.sources = Object.fromEntries(
        Object.entries(f.spec.sources).reverse(),
    ) as SourceSpec["sources"];

    const requestStart = f.requests.length;
    const second = await prepare(f);

    downloadedAll(f, requestStart);
    assert.deepEqual(second, first);
    assert.deepEqual(await readFile(f.manifestPath), firstText);
    await assertBundle(f, second);
    assert.deepEqual(await readdir(join(f.root, "unrelated-working-directory")), []);
});

test("Victor verified preparation is a no-op with unchanged bytes and mtimes", async (t) => {
    const f = await fixture(t);
    const manifest = await prepare(f);
    const receiptPath = join(f.directory, ".prepared.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

    assert.deepEqual(receipt, {
        inputs: hash(
            JSON.stringify([
                await readFile(join(f.root, "victor-sources.json"), "utf8"),
                await readFile(f.script, "utf8"),
            ]),
        ),
        manifest: hash(await readFile(f.manifestPath)),
    });

    const paths = [
        f.manifestPath,
        receiptPath,
        ...manifest.assets.map((asset) => join(f.directory, manifest.bundle, asset.sha256)),
    ];
    const oldTime = new Date("2001-01-01T00:00:00Z");

    for (const path of paths) {
        await utimes(path, oldTime, oldTime);
    }

    const before = await Promise.all(
        paths.map(async (path) => ({
            bytes: await readFile(path),
            mtime: (await stat(path)).mtimeMs,
        })),
    );
    const requestStart = f.requests.length;
    const result = await f.run();

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Victor assets already prepared and verified:/);
    assert.equal(f.requests.length, requestStart);
    assert.deepEqual(
        await Promise.all(
            paths.map(async (path) => ({
                bytes: await readFile(path),
                mtime: (await stat(path)).mtimeMs,
            })),
        ),
        before,
    );
    await assertBundle(f, manifest);
});

test("Victor raw source or builder edits force full preparation", async (t) => {
    const f = await fixture(t);
    const manifest = await prepare(f);

    for (const path of [join(f.root, "victor-sources.json"), f.script]) {
        await writeFile(
            path,
            (await readFile(path, "utf8")) +
                (path === f.script ? "\n// Changed builder input.\n" : "\n"),
        );

        const requestStart = f.requests.length;
        const result = await f.run();

        assert.equal(result.code, 0, result.stderr);
        downloadedAll(f, requestStart);
        assert.doesNotMatch(result.stdout, /already prepared and verified/);
        assert.deepEqual(await f.manifest(), manifest);
        await assertBundle(f, manifest);
    }
});

test("Victor missing or invalid receipts, manifests and blobs force full preparation", async (t) => {
    const cases = [
        "missing receipt",
        "malformed receipt",
        "wrong inputs",
        "wrong manifest hash",
        "missing manifest",
        "malformed manifest",
        "changed manifest bytes",
        "invalid bundle identity",
        "missing blob",
        "truncated blob",
        "corrupt blob",
        "symlink blob",
    ];

    for (const name of cases) {
        await t.test(name, async (t) => {
            const f = await fixture(t);
            const manifest = await prepare(f);
            const receiptPath = join(f.directory, ".prepared.json");
            const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
            const asset = manifest.assets[0]!;
            const blob = join(f.directory, manifest.bundle, asset.sha256);

            switch (name) {
                case "missing receipt":
                    await rm(receiptPath);
                    break;
                case "malformed receipt":
                    await writeFile(receiptPath, "{");
                    break;
                case "wrong inputs":
                    await writeFile(
                        receiptPath,
                        JSON.stringify({ ...receipt, inputs: "0".repeat(64) }),
                    );
                    break;
                case "wrong manifest hash":
                    await writeFile(
                        receiptPath,
                        JSON.stringify({ ...receipt, manifest: "0".repeat(64) }),
                    );
                    break;
                case "missing manifest":
                    await rm(f.manifestPath);
                    break;
                case "malformed manifest":
                    await writeFile(f.manifestPath, "{");
                    break;
                case "changed manifest bytes":
                    await writeFile(
                        f.manifestPath,
                        (await readFile(f.manifestPath, "utf8")) + "\n",
                    );
                    break;

                case "invalid bundle identity": {
                    const changed = {
                        ...manifest,
                        model: { ...manifest.model, sampleRate: 22050 },
                    };
                    const bytes = JSON.stringify(changed);

                    await writeFile(f.manifestPath, bytes);
                    await writeFile(
                        receiptPath,
                        JSON.stringify({ ...receipt, manifest: hash(bytes) }),
                    );
                    break;
                }

                case "missing blob":
                    await rm(blob);
                    break;
                case "truncated blob":
                    await writeFile(blob, "");
                    break;
                case "corrupt blob":
                    await writeFile(blob, Buffer.alloc(asset.bytes, 0x7f));
                    break;

                case "symlink blob": {
                    const target = join(f.root, "external-blob");

                    await copyFile(blob, target);
                    await rm(blob);
                    await symlink(target, blob);
                    break;
                }
            }

            const requestStart = f.requests.length;
            const result = await f.run();

            assert.equal(result.code, 0, result.stderr);
            downloadedAll(f, requestStart);
            assert.deepEqual(await f.manifest(), manifest);
            await assertBundle(f, manifest);
        });
    }
});

test("Victor archive order and timestamps change source pins, not asset hashes or pronunciation offsets", async (t) => {
    const f = await fixture(t);
    const first = await prepare(f);

    for (const id of ids) {
        f.entries[id].reverse();

        for (const entry of f.entries[id]) {
            entry.mtime = 1_700_000_000;
            entry.path = "./" + entry.path + (entry.type === "5" ? "/" : "");
        }

        f.pin(id);
    }

    f.spec.assets.reverse();

    const second = await prepare(f);

    assert.notEqual(second.bundle, first.bundle);
    assert.deepEqual(second.assets, first.assets);
    assert.deepEqual(second.tts.pronunciation, first.tts.pronunciation);

    for (const id of ids) {
        assert.notEqual(second.sources[id].sha256, first.sources[id].sha256);
    }

    await assertBundle(f, second);
});

test("Victor ASR, TTS, configuration, index and provenance changes publish coherent new bundles", async (t) => {
    const f = await fixture(t);
    let previous = await prepare(f);

    for (const name of [f.spec.model.encoder, f.spec.tts.model, f.spec.tts.voices]) {
        const asset = f.spec.assets.find((asset) => asset.name === name)!;
        const entry = f.entries[asset.source].find((entry) => entry.path === asset.member)!;
        const bytes = Buffer.from(`updated ${name}`);
        const requestStart = f.requests.length;

        entry.bytes = bytes;
        f.direct.set(name, bytes);
        f.pin(asset.source);

        const next = await prepare(f);

        downloadedAll(f, requestStart);
        assert.notEqual(next.bundle, previous.bundle);
        assert.deepEqual(changedAssets(previous, next), [name]);
        await assertBundle(f, next);
        previous = next;
    }

    f.spec.model.sampleRate = 22050;
    f.spec.model.featureDim = 96;

    let next = await prepare(f);

    assert.notEqual(next.bundle, previous.bundle);
    assert.deepEqual(next.assets, previous.assets);
    await assertBundle(f, next);
    previous = next;

    f.spec.sources.runtime.revision = "b".repeat(40);
    next = await prepare(f);
    assert.notEqual(next.bundle, previous.bundle);
    assert.deepEqual(next.assets, previous.assets);
    assert.equal(next.sources.runtime.revision, f.spec.sources.runtime.revision);
    previous = next;

    const entry = f.entries.tts.find((entry) => entry.path === prefix + "a_dict")!;
    const bytes = entry.bytes!;

    entry.path = prefix + "b_dict";
    f.pronunciation.delete("a_dict");
    f.pronunciation.set("b_dict", bytes);
    f.pin("tts");
    next = await prepare(f);
    assert.notEqual(next.bundle, previous.bundle);
    assert.deepEqual(next.assets, previous.assets);
    assert.notDeepEqual(next.tts.pronunciation, previous.tts.pronunciation);
    await assertBundle(f, next);
    previous = next;

    const japanese = f.entries.tts.find((entry) => entry.path === prefix + "lang/jpx/ja")!;
    const phonemes = Buffer.from([1, 254, 127, 6]);

    japanese.bytes = phonemes;
    f.pronunciation.set("lang/jpx/ja", phonemes);
    f.pin("tts");
    next = await prepare(f);
    assert.notEqual(next.bundle, previous.bundle);
    assert.deepEqual(changedAssets(previous, next), ["tts/pronunciation.data"]);
    assert.deepEqual(next.tts.pronunciation, previous.tts.pronunciation);
    await assertBundle(f, next);
    previous = next;

    f.spec.sources.model.url = f.spec.sources.model.url.replace("model.tar.gz", "model-v2.tar.gz");
    f.archives.set("/model-v2.tar.gz", f.archives.get("/model.tar.gz")!);
    next = await prepare(f);
    assert.notEqual(next.bundle, previous.bundle);
    assert.deepEqual(next.assets, previous.assets);
    assert.deepEqual(next.tts.pronunciation, previous.tts.pronunciation);
    await assertBundle(f, next);
});

test("Victor source members and pronunciation prefix can move without changing installed names", async (t) => {
    const f = await fixture(t);
    const before = await prepare(f);
    const asset = f.spec.assets.find((asset) => asset.name === f.spec.model.encoder)!;
    const entry = f.entries.model.find((entry) => entry.path === asset.member)!;

    asset.member = "new-model-layout/encoder-v2.onnx";
    entry.path = asset.member;
    f.spec.tts.pronunciation.prefix = "updated-kitten/pronunciation/";
    delete f.spec.sources.runtime.revision;

    for (const entry of f.entries.tts) {
        if (entry.path.startsWith(prefix)) {
            entry.path = f.spec.tts.pronunciation.prefix + entry.path.slice(prefix.length);
        } else if (entry.path === prefix.slice(0, -1)) {
            entry.path = f.spec.tts.pronunciation.prefix.slice(0, -1);
        }
    }

    f.pin("model");
    f.pin("tts");

    const after = await prepare(f);

    assert.notEqual(after.bundle, before.bundle);
    assert.deepEqual(after.assets, before.assets);
    assert.deepEqual(after.tts.pronunciation, before.tts.pronunciation);
    assert.ok(!("revision" in after.sources.runtime));
    await assertBundle(f, after);
});

test("Victor rejects each bad archive pin before installing output or replacing the current manifest", async (t) => {
    const f = await fixture(t);
    const previous = await prepare(f);
    const manifestBytes = await readFile(f.manifestPath);

    // Invalidate the receipt so altered upstream archives are actually requested.
    await writeFile(join(f.directory, ".prepared.json"), "{}");

    const names = (await readdir(f.directory)).sort();

    for (const id of ids) {
        await t.test(id, async () => {
            const url = `/${id}.tar.gz`;
            const bytes = f.archives.get(url)!;

            // Also contains an unsafe archive member: the hash failure must win over extraction.
            f.archives.set(
                url,
                archive([...f.entries[id], { path: "../escaped", bytes: Buffer.from("bad") }]),
            );

            const result = await f.run();

            assert.notEqual(result.code, 0);
            assert.match(result.stderr, /SHA-?256|hash mismatch/i);
            assert.deepEqual(await readFile(f.manifestPath), manifestBytes);
            assert.deepEqual((await readdir(f.directory)).sort(), names);
            await assertBundle(f, previous);
            f.archives.set(url, bytes);
        });
    }
});

test("Victor validates the supported source layout before any archive request", async (t) => {
    const cases: [string, (spec: SourceSpec) => void][] = [
        ["source schema", (spec) => (spec.schemaVersion = 2)],
        ["unexpected fields", (spec) => Object.assign(spec, { obsoleteRecipe: true })],
        ["ASR engine", (spec) => (spec.model.type = "whisper")],
        ["TTS engine", (spec) => (spec.tts.type = "vits")],
        ["ASR sample rate zero", (spec) => (spec.model.sampleRate = 0)],
        ["ASR sample rate fractional", (spec) => (spec.model.sampleRate = 16000.5)],
        ["ASR feature dimension negative", (spec) => (spec.model.featureDim = -1)],
        ["ASR feature dimension unsafe", (spec) => (spec.model.featureDim = 2 ** 53)],
        ["TTS sample rate", (spec) => (spec.tts.sampleRate = 16000)],
        ["missing direct asset", (spec) => spec.assets.pop()],
        [
            "extra direct asset",
            (spec) => spec.assets.push({ ...spec.assets[0]!, name: "extra.js" }),
        ],
        ["duplicate direct asset", (spec) => (spec.assets[1]!.name = spec.assets[0]!.name)],
        ["config asset missing", (spec) => (spec.model.encoder = "absent.onnx")],
        [
            "unsafe output name",
            (spec) => (spec.runtime.script = spec.assets[0]!.name = "../escape.js"),
        ],
        ["unsafe archive member", (spec) => (spec.assets[0]!.member = "../escape.js")],
        ["absolute archive member", (spec) => (spec.assets[0]!.member = "/escape.js")],
        ["backslash archive member", (spec) => (spec.assets[0]!.member = "assets\\escape.js")],
        ["unsafe prefix", (spec) => (spec.tts.pronunciation.prefix = "kitten/../escape/")],
        ["unsafe data directory", (spec) => (spec.tts.dataDir = "tts/../escape")],
        ["invalid archive hash", (spec) => (spec.sources.model.sha256 = "not-a-hash")],
        ["unsupported URL scheme", (spec) => (spec.sources.tts.url = "file:///tmp/tts.tar.gz")],
    ];

    for (const [name, change] of cases) {
        await t.test(name, async (t) => {
            const f = await fixture(t);

            change(f.spec);
            await f.save();

            const result = await f.run();

            assert.notEqual(result.code, 0, result.stdout);
            assert.match(
                result.stderr,
                /source|schema|config|asset|invalid|unsafe|unsupported|must|expected/i,
            );
            assert.deepEqual(f.requests, []);
            await assert.rejects(readFile(f.manifestPath), { code: "ENOENT" });
        });
    }
});

test("Victor rejects unsafe archive entries, duplicates, links, link ancestors and path collisions", async (t) => {
    const directMember = "assets/sherpa-onnx-wasm-web.js";
    const file = (path: string): TarEntry => ({ path, bytes: Buffer.from("bad") });
    const link = (path: string, type: "1" | "2" = "2"): TarEntry => ({ path, type, link: "/tmp" });
    const cases: [string, SourceId, TarEntry | undefined, string?][] = [
        ["traversal", "tts", file(prefix + "../escape")],
        ["absolute path", "tts", file("/tmp/victor-escape")],
        ["backslash", "tts", file(prefix + "lang\\escape")],
        ["duplicate direct entry", "runtime", file(directMember)],
        ["duplicate normalized entry", "runtime", file("./" + directMember)],
        ["duplicate unselected entry", "runtime", file("unused-runtime/README")],
        ["duplicate pronunciation entry", "tts", file(prefix + "en_dict")],
        ["selected glob operand", "tts", file(prefix + "lang/*")],
        ["selected symbolic link", "runtime", link(directMember), directMember],
        ["selected hard link", "runtime", link(directMember, "1"), directMember],
        ["pronunciation symbolic link", "tts", link(prefix + "linked")],
        ["unselected symbolic link", "runtime", link("unused-link")],
        ["unselected special file", "runtime", { path: "unused-fifo", type: "6" }],
        ["symbolic link ancestor", "tts", link(prefix + "lang")],
        ["hard link ancestor", "tts", link(prefix + "lang", "1")],
        ["direct asset link ancestor", "runtime", link("assets")],
        ["file ancestor", "tts", file(prefix + "lang")],
        ["direct asset is a directory", "runtime", { path: directMember, type: "5" }, directMember],
        ["missing selected member", "runtime", undefined, directMember],
        ["empty pronunciation tree", "tts", undefined, prefix],
    ];

    for (const [name, id, addition, remove] of cases) {
        await t.test(name, async (t) => {
            const f = await fixture(t);

            if (remove) {
                f.entries[id] = f.entries[id].filter((entry) =>
                    remove.endsWith("/") ? !entry.path.startsWith(remove) : entry.path !== remove,
                );
            }

            if (addition) {
                f.entries[id].push(addition);
            }

            f.pin(id);
            await f.save();

            const result = await f.run();

            assert.notEqual(result.code, 0, result.stdout);
            assert.match(
                result.stderr,
                /unsafe|duplicate|link|ancestor|collision|directory|missing|not found|empty|no pronunciation|no files|regular|member/i,
            );
            await assert.rejects(readFile(f.manifestPath), { code: "ENOENT" });

            const installed = await readdir(f.directory).catch((error: NodeJS.ErrnoException) => {
                assert.equal(error.code, "ENOENT");

                return [] as string[];
            });

            assert.deepEqual(installed, []);
            await assert.rejects(readFile(join(f.root, "escaped")), { code: "ENOENT" });
        });
    }
});

test("Victor rejects packed-file collisions with direct TTS files before replacing the manifest", async (t) => {
    const f = await fixture(t);
    const current = await prepare(f);
    const currentBytes = await readFile(f.manifestPath);
    const asset = f.spec.assets.find((asset) => asset.name === f.spec.tts.model)!;

    asset.name = f.spec.tts.model = `${f.spec.tts.dataDir}/en_dict`;
    await f.save();

    const result = await f.run();

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /duplicate|collision/i);
    assert.deepEqual(await readFile(f.manifestPath), currentBytes);

    for (const asset of current.assets) {
        assert.equal(hash(await f.readAsset(current, asset.name)), asset.sha256);
    }

    await assertClean(f);
});

test("Victor interrupted installation preserves the current manifest; invalidated reruns rebuild and repair output", async (t) => {
    const f = await fixture(t);
    const current = await prepare(f);
    const currentBytes = await readFile(f.manifestPath);
    const asset = f.spec.assets.find((asset) => asset.name === f.spec.tts.model)!;
    const entry = f.entries.tts.find((entry) => entry.path === asset.member)!;
    const bytes = Buffer.from("next Kitten model");

    entry.bytes = bytes;
    f.direct.set(asset.name, bytes);
    f.pin("tts");

    // Obtain the next identity from a separate checkout, without exposing it in the current one.
    const preview = await fixture(t);

    Object.assign(preview.spec, structuredClone(f.spec));

    // The spec uses the first fixture's server, but the preview writes only its own vendor directory.
    const next = await prepare(preview);
    const destination = join(f.directory, next.bundle);
    const blocked = join(destination, hash(bytes));

    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, "blocker"), "prevent atomic blob rename");
    await f.save();

    const requestStart = f.requests.length;
    const failed = await f.run();

    downloadedAll(f, requestStart);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /EISDIR|ENOTEMPTY|directory|rename/i);
    assert.deepEqual(await readFile(f.manifestPath), currentBytes);

    for (const asset of current.assets) {
        assert.equal(hash(await f.readAsset(current, asset.name)), asset.sha256);
    }

    await assertClean(f);
    await rm(blocked, { recursive: true });

    const retryStart = f.requests.length;
    const repaired = await prepare(f);

    downloadedAll(f, retryStart);
    assert.deepEqual(repaired, next);
    await assertBundle(f, repaired);

    const corrupt = repaired.assets[0]!;
    const missing = repaired.assets[1]!;

    await writeFile(join(destination, corrupt.sha256), Buffer.alloc(corrupt.bytes, 0x7f));
    await rm(join(destination, missing.sha256));
    await writeFile(f.manifestPath, "broken generated manifest");

    const repairStart = f.requests.length;
    const rebuilt = await prepare(f);

    downloadedAll(f, repairStart);
    assert.deepEqual(rebuilt, repaired);
    await assertBundle(f, rebuilt);
});

test("Victor CLI offers help without reading a spec and rejects removed preparation flags", async (t) => {
    const f = await fixture(t);

    await rm(join(f.root, "victor-sources.json"));

    const help = await f.run(["--help"]);

    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /prepare-victor-assets/);
    assert.match(help.stdout, /3|three/i);
    assert.match(help.stdout, /verified|verif|unchanged|already prepared/i);
    assert.doesNotMatch(help.stdout, /--(?:runtime|model|tts)-archive|--refresh-manifest/);
    assert.deepEqual(f.requests, []);

    for (const args of [
        ["--runtime-archive", "runtime.tar.gz"],
        ["--model-archive", "model.tar.gz"],
        ["--tts-archive", "tts.tar.gz"],
        ["--refresh-manifest"],
        ["--unknown"],
        ["unexpected-positional-argument"],
    ]) {
        const result = await f.run(args);

        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /unknown|unexpected|argument|option/i);
    }

    assert.deepEqual(f.requests, []);
    await assert.rejects(readFile(f.manifestPath), { code: "ENOENT" });
});
