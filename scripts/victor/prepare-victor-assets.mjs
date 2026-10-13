#!/usr/bin/env node
/** Build the pinned Victor bundle and publish its generated manifest last. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = join(root, "vendor", "victor");
const exec = promisify(execFile);
const labels = ["runtime", "model", "tts"];
const packName = "tts/pronunciation.data";
const lexical = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function megabytes(bytes) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function fields(value, required, optional = []) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        required.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
    ) {
        throw new Error("Invalid Victor source specification fields");
    }
}

function safePath(path) {
    if (
        typeof path !== "string" ||
        !path ||
        /[\\\x00-\x1f\x7f]/.test(path) ||
        path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
        throw new Error(`Unsafe Victor path: ${JSON.stringify(path)}`);
    }

    return path;
}

function positiveInteger(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("Expected a positive safe integer in Victor configuration");
    }

    return value;
}

/** Explicit reconstruction fixes field order without a general canonical-JSON format. */
function specification(data) {
    fields(data, ["schemaVersion", "runtime", "model", "tts", "sources", "assets"]);

    if (data.schemaVersion !== 1) {
        throw new Error("Unsupported Victor source schema");
    }

    fields(data.runtime, ["script", "wrapper", "wasm", "ttsWrapper"]);
    fields(data.model, [
        "type",
        "encoder",
        "decoder",
        "joiner",
        "tokens",
        "sampleRate",
        "featureDim",
    ]);
    fields(data.tts, [
        "type",
        "model",
        "voices",
        "tokens",
        "dataDir",
        "sampleRate",
        "pronunciation",
    ]);
    fields(data.tts.pronunciation, ["source", "prefix"]);
    fields(data.sources, labels);

    if (
        data.model.type !== "zipformer2" ||
        data.tts.type !== "kitten" ||
        data.tts.sampleRate !== 24000
    ) {
        throw new Error("Unsupported Victor engine configuration");
    }

    const runtime = {
        script: safePath(data.runtime.script),
        wrapper: safePath(data.runtime.wrapper),
        wasm: safePath(data.runtime.wasm),
        ttsWrapper: safePath(data.runtime.ttsWrapper),
    };
    const model = {
        type: data.model.type,
        encoder: safePath(data.model.encoder),
        decoder: safePath(data.model.decoder),
        joiner: safePath(data.model.joiner),
        tokens: safePath(data.model.tokens),
        sampleRate: positiveInteger(data.model.sampleRate),
        featureDim: positiveInteger(data.model.featureDim),
    };
    const tts = {
        type: data.tts.type,
        model: safePath(data.tts.model),
        voices: safePath(data.tts.voices),
        tokens: safePath(data.tts.tokens),
        dataDir: safePath(data.tts.dataDir),
        sampleRate: data.tts.sampleRate,
    };
    const pronunciation = data.tts.pronunciation;

    if (
        Object.values(runtime).some((name) => name.includes("/")) ||
        [model.encoder, model.decoder, model.joiner, model.tokens].some((name) =>
            name.includes("/"),
        ) ||
        [tts.model, tts.voices, tts.tokens, tts.dataDir].some((name) => !name.startsWith("tts/")) ||
        pronunciation.source !== "tts" ||
        typeof pronunciation.prefix !== "string" ||
        !pronunciation.prefix.endsWith("/")
    ) {
        throw new Error("Unsupported Victor asset layout");
    }

    const prefix = safePath(pronunciation.prefix.slice(0, -1)) + "/";
    const sources = {};

    for (const label of labels) {
        const source = data.sources[label];

        fields(source, ["url", "sha256"], ["revision"]);

        if (
            typeof source.url !== "string" ||
            !["http:", "https:"].includes(new URL(source.url).protocol) ||
            typeof source.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(source.sha256) ||
            (source.revision !== undefined &&
                (typeof source.revision !== "string" || !/^[a-f0-9]{40}$/.test(source.revision)))
        ) {
            throw new Error(`Invalid Victor ${label} source pin`);
        }

        sources[label] = { url: source.url, sha256: source.sha256 };

        if (source.revision !== undefined) {
            sources[label].revision = source.revision;
        }
    }

    const expected = [
        [runtime.script, "runtime", "text/javascript; charset=utf-8"],
        [runtime.wrapper, "runtime", "text/javascript; charset=utf-8"],
        [runtime.wasm, "runtime", "application/wasm"],
        [runtime.ttsWrapper, "runtime", "text/javascript; charset=utf-8"],
        ...[model.encoder, model.decoder, model.joiner].map((name) => [
            name,
            "model",
            "application/octet-stream",
        ]),
        [model.tokens, "model", "text/plain; charset=utf-8"],
        ...[tts.model, tts.voices, tts.tokens].map((name) => [
            name,
            "tts",
            "application/octet-stream",
        ]),
    ];

    if (!Array.isArray(data.assets) || data.assets.length !== expected.length) {
        throw new Error("Victor requires exactly 11 direct assets");
    }

    const names = new Set();
    const members = new Set();
    const assets = data.assets
        .map((asset) => {
            fields(asset, ["name", "source", "member", "contentType"]);
            safePath(asset.name);
            safePath(asset.member);

            if (
                !expected.some(
                    ([name, source, type]) =>
                        name === asset.name &&
                        source === asset.source &&
                        type === asset.contentType,
                ) ||
                !asset.name
                    .split("/")
                    .every((part) => /^[a-zA-Z0-9_!][a-zA-Z0-9_.! -]*$/.test(part)) ||
                names.has(asset.name) ||
                members.has(`${asset.source}/${asset.member}`) ||
                asset.name === packName ||
                (asset.source === "tts" && asset.member.startsWith(prefix))
            ) {
                throw new Error("Invalid or duplicate Victor direct asset");
            }

            names.add(asset.name);
            members.add(`${asset.source}/${asset.member}`);

            return {
                name: asset.name,
                source: asset.source,
                member: asset.member,
                contentType: asset.contentType,
            };
        })
        .sort((a, b) => lexical(a.name, b.name));

    validateFiles([...names, packName], [tts.dataDir]);

    return { runtime, model, tts, sources, assets, prefix };
}

/** Files cannot also be directories, whether explicitly named or implied by a child. */
function validateFiles(files, directories = []) {
    const names = new Set();

    for (const path of files) {
        safePath(path);

        if (names.has(path)) {
            throw new Error(`Duplicate Victor file: ${path}`);
        }

        names.add(path);
    }

    for (const path of [...files, ...directories]) {
        safePath(path);

        if (directories.includes(path) && names.has(path)) {
            throw new Error(`Victor file/directory collision: ${path}`);
        }

        const parts = path.split("/");

        while (parts.length > 1) {
            parts.pop();

            if (names.has(parts.join("/"))) {
                throw new Error(`Victor file/directory collision: ${path}`);
            }
        }
    }
}

async function sha256(file) {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
    }

    return hash.digest("hex");
}

async function download(url, file, label) {
    const signal = AbortSignal.timeout(15 * 60_000);
    const response = await fetch(url, { signal });

    if (!response.ok || !response.body) {
        throw new Error(`${label} download returned HTTP ${response.status}`);
    }

    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    let lastReport = Date.now();

    console.log(`Downloading ${label}${total ? ` (${megabytes(total)})` : ""}…`);
    await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
            transform(chunk, _encoding, done) {
                received += chunk.length;

                if (Date.now() - lastReport >= 2000) {
                    console.log(
                        `  ${label}: ${megabytes(received)}${total ? ` / ${megabytes(total)}` : ""}`,
                    );
                    lastReport = Date.now();
                }

                done(null, chunk);
            },
        }),
        createWriteStream(file),
        { signal },
    );
    console.log(`  ${label}: downloaded ${megabytes(received)}`);
}

async function tar(args) {
    return exec("tar", args, {
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        maxBuffer: 16 * 1024 * 1024,
    });
}

/** Pair tar's name and type listings; never infer a filename from verbose columns. */
async function selectedMembers(archive, direct, prefix) {
    const [plain, verbose] = await Promise.all([tar(["-tf", archive]), tar(["-tvf", archive])]);
    const names = plain.stdout.slice(0, -1).split("\n");
    const types = verbose.stdout.slice(0, -1).split("\n");

    if (!plain.stdout.endsWith("\n") || names.length !== types.length) {
        throw new Error("Unsupported tar listing");
    }

    const entries = new Map();
    const selected = [];

    for (let i = 0; i < names.length; i++) {
        const member = names[i];
        const type = types[i][0];
        // Tar may spell relative entries with ./ and directory entries with a trailing slash.
        const path = member.replace(/^(\.\/)+/, "").replace(type === "d" ? /\/$/ : /$^/, "");

        if ((member === "." || member === "./") && type === "d") {
            continue;
        }

        safePath(path);

        if (type !== "-" && type !== "d") {
            throw new Error(
                `Unsafe archive entry (links and special files are forbidden): ${member}`,
            );
        }

        if (entries.has(path)) {
            throw new Error(`Duplicate archive entry: ${path}`);
        }

        entries.set(path, type);

        if (direct.includes(path) || (prefix && path.startsWith(prefix))) {
            // bsdtar treats operands as patterns; current members need no glob syntax.
            if (/[*?\[]/.test(member)) {
                throw new Error(`Unsupported archive member pattern: ${member}`);
            }

            if (type === "-") {
                selected.push({ path, member });
            } else if (direct.includes(path)) {
                throw new Error(`Direct archive member is not a file: ${path}`);
            }
        }
    }

    // Link entries were rejected above, including links outside the selected subtree.
    validateFiles(
        [...entries].filter(([, type]) => type === "-").map(([path]) => path),
        [...entries].filter(([, type]) => type === "d").map(([path]) => path),
    );

    for (const path of direct) {
        if (entries.get(path) !== "-") {
            throw new Error(`Missing direct archive member: ${path}`);
        }
    }

    if (prefix && !selected.some(({ path }) => path.startsWith(prefix))) {
        throw new Error("Missing pronunciation tree");
    }

    return selected.sort((a, b) => lexical(a.path, b.path));
}

async function assetFile(file, name, contentType, prepared) {
    const info = await lstat(file);

    if (!info.isFile()) {
        throw new Error(`Extracted Victor member is not a regular file: ${name}`);
    }

    positiveInteger(info.size);
    const hash = await sha256(file);

    // Hash names also keep repository formatters away from upstream JavaScript.
    await rename(file, join(prepared, hash));

    return { name, bytes: info.size, sha256: hash, contentType };
}

async function build(spec, staging) {
    const prepared = join(staging, "bundle");
    const archives = {};
    const assets = [];
    const files = [];

    await mkdir(prepared);

    // Verify all source pins before extracting any archive.
    for (const label of labels) {
        const archive = join(staging, `${label}.tar`);

        await download(spec.sources[label].url, archive, label);

        if ((await sha256(archive)) !== spec.sources[label].sha256) {
            throw new Error(`SHA-256 mismatch for downloaded ${label} archive`);
        }

        archives[label] = archive;
    }

    for (const label of labels) {
        const direct = spec.assets.filter((asset) => asset.source === label);
        const prefix = label === "tts" ? spec.prefix : undefined;
        const selected = await selectedMembers(
            archives[label],
            direct.map((asset) => asset.member),
            prefix,
        );
        const extraction = join(staging, label);

        await mkdir(extraction);
        console.log(`Extracting selected ${label} files…`);
        await tar([
            "-xf",
            archives[label],
            "-C",
            extraction,
            "--",
            ...selected.map(({ member }) => member),
        ]);

        for (const asset of direct) {
            assets.push(
                await assetFile(
                    join(extraction, asset.member),
                    asset.name,
                    asset.contentType,
                    prepared,
                ),
            );
        }

        if (prefix) {
            const pack = join(staging, "pronunciation.data");
            const output = await open(pack, "wx");
            let offset = 0;

            try {
                for (const { path } of selected.filter(({ path }) => path.startsWith(prefix))) {
                    const file = join(extraction, path);
                    const info = await lstat(file);

                    if (!info.isFile()) {
                        throw new Error(`Pronunciation member is not a regular file: ${path}`);
                    }

                    const bytes = await readFile(file);

                    files.push({ path: path.slice(prefix.length), offset, bytes: bytes.length });
                    await output.writeFile(bytes);
                    offset += bytes.length;
                }
            } finally {
                await output.close();
            }

            assets.push(await assetFile(pack, packName, "application/octet-stream", prepared));
        }
    }

    assets.sort((a, b) => lexical(a.name, b.name));
    const payload = {
        schemaVersion: 2,
        runtime: spec.runtime,
        model: spec.model,
        tts: { ...spec.tts, pronunciation: { asset: packName, files } },
        sources: spec.sources,
        assets,
    };
    const bundle = `victor-${digest(JSON.stringify(payload))}`;
    const manifest = { ...payload, bundle, bundleBase: `/victor-assets/${bundle}/` };

    await validateResult(manifest, prepared);

    return { prepared, manifest };
}

async function validateResult(manifest, prepared) {
    const { files } = manifest.tts.pronunciation;
    const pack = manifest.assets.find((asset) => asset.name === packName);
    let end = 0;
    let previous;

    if (manifest.schemaVersion !== 2 || manifest.assets.length !== 12 || !pack || !files.length) {
        throw new Error("Incomplete Victor bundle");
    }

    for (const file of files) {
        safePath(file.path);

        if (
            !Number.isSafeInteger(file.offset) ||
            !Number.isSafeInteger(file.bytes) ||
            file.bytes < 0 ||
            file.offset !== end ||
            (previous !== undefined && lexical(previous, file.path) >= 0)
        ) {
            throw new Error("Invalid pronunciation index");
        }

        end += file.bytes;
        previous = file.path;
    }

    if (end !== pack.bytes) {
        throw new Error("Pronunciation index does not cover the pack");
    }

    validateFiles(
        [
            ...manifest.assets.map((asset) => asset.name),
            ...files.map((file) => `${manifest.tts.dataDir}/${file.path}`),
        ],
        [manifest.tts.dataDir],
    );

    for (const asset of manifest.assets) {
        const file = join(prepared, asset.sha256);
        const info = await lstat(file);

        if (!info.isFile() || info.size !== asset.bytes || (await sha256(file)) !== asset.sha256) {
            throw new Error(`Size or SHA-256 mismatch for built ${asset.name}`);
        }
    }
}

/** A local build receipt binds verified output to both inputs, without retaining archives. */
async function alreadyPrepared(inputs) {
    try {
        const receipt = JSON.parse(await readFile(join(directory, ".prepared.json"), "utf8"));
        const text = await readFile(join(directory, "manifest.json"), "utf8");

        if (receipt.inputs !== inputs || receipt.manifest !== digest(text)) {
            return false;
        }

        const { bundle, bundleBase, ...payload } = JSON.parse(text);

        if (
            bundle !== `victor-${digest(JSON.stringify(payload))}` ||
            bundleBase !== `/victor-assets/${bundle}/` ||
            !payload.assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256)) ||
            !(await lstat(join(directory, bundle))).isDirectory()
        ) {
            return false;
        }

        await validateResult(payload, join(directory, bundle));
        console.log(`Victor assets already prepared and verified: ${join(directory, bundle)}`);

        return true;
    } catch {
        // Missing, obsolete, or damaged output takes the ordinary full-build path.
        return false;
    }
}

async function prepare() {
    const { values } = parseArgs({ options: { help: { type: "boolean", short: "h" } } });

    if (values.help) {
        console.log(`Usage: node scripts/victor/prepare-victor-assets.mjs

Prepares 12 Victor assets from the 3 pinned archives in victor-sources.json.
Skips downloading only when source and builder inputs match the last successful build
and the installed manifest and all blobs pass verification. Otherwise rebuilds fully.
Requires system tar with gzip/bzip2 support; no archives or downloads are cached.
Publishes vendor/victor/manifest.json last and discards all staging/download files.
Assets stay in this checkout, never Pi Pocket's live data folder.

  -h, --help  Show this help`);

        return;
    }

    const source = await readFile(join(root, "victor-sources.json"), "utf8");
    const spec = specification(JSON.parse(source));
    const inputs = digest(
        JSON.stringify([source, await readFile(new URL(import.meta.url), "utf8")]),
    );

    if (await alreadyPrepared(inputs)) {
        return;
    }

    await mkdir(directory, { recursive: true });

    const staging = await mkdtemp(join(directory, ".prepare-"));

    try {
        const { prepared, manifest } = await build(spec, staging);
        const bundle = join(directory, manifest.bundle);
        const manifestFile = join(staging, "manifest.json");

        const manifestText = JSON.stringify(manifest, null, 4) + "\n";
        const receiptFile = join(staging, ".prepared.json");

        await writeFile(manifestFile, manifestText);
        await writeFile(
            receiptFile,
            JSON.stringify({ inputs, manifest: digest(manifestText) }) + "\n",
        );
        await mkdir(bundle, { recursive: true });

        // Replace rebuilt blobs atomically, without deleting an existing bundle directory.
        for (const hash of new Set(manifest.assets.map((asset) => asset.sha256))) {
            await rename(join(prepared, hash), join(bundle, hash));
        }

        // A receipt for an unpublished manifest cannot pass the next invocation's hash check.
        await rename(receiptFile, join(directory, ".prepared.json"));

        // Readers never see a new manifest until all its blobs are installed.
        await rename(manifestFile, join(directory, "manifest.json"));

        for (const asset of manifest.assets) {
            console.log(`  ${asset.name}: ${asset.bytes} bytes, SHA-256 ${asset.sha256}`);
        }

        console.log(`Victor assets ready: ${bundle}`);
        console.log(
            `${manifest.assets.length} assets (${megabytes(manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0))}); ${manifest.tts.pronunciation.files.length} packed pronunciation files.`,
        );
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

try {
    await prepare();
} catch (error) {
    console.error(`Victor asset preparation failed: ${error.message}`);
    process.exitCode = 1;
}
