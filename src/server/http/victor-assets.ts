/** Pinned Victor assets and the policies for the two speech scripts. */
import { createReadStream, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { APP_ROOT } from "../config.ts";
import { HttpError } from "../errors.ts";

type VictorFile = { file: string; bytes: number; sha256: string; contentType: string };
type VictorBundle = { manifest: string; files: Map<string, VictorFile> };
const BUNDLE = /^victor-[a-f0-9]{64}$/;
// The pinned pronunciation tree includes !v and filenames such as "Mr serious".
const SEGMENT = /^[a-zA-Z0-9_!][a-zA-Z0-9_.! -]*$/;
const CONTENT_TYPES = new Set([
    "text/javascript; charset=utf-8",
    "application/wasm",
    "application/octet-stream",
    "text/plain; charset=utf-8",
]);

/** Packed paths preserve upstream spaces and punctuation but cannot escape their directory. */
function safePath(path: unknown): path is string {
    return (
        typeof path === "string" &&
        path.length > 0 &&
        !/[\\\x00-\x1f\x7f]/.test(path) &&
        path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    );
}

/** Validate the public layout and every field used for file paths or response headers. */
function loadBundle(root: string): VictorBundle {
    const manifest = readFileSync(join(root, "vendor", "victor", "manifest.json"), "utf8");
    const data = JSON.parse(manifest);

    if (
        !data ||
        data.schemaVersion !== 2 ||
        typeof data.bundle !== "string" ||
        !BUNDLE.test(data.bundle) ||
        data.bundleBase !== "/victor-assets/" + data.bundle + "/" ||
        !Array.isArray(data.assets) ||
        data.assets.length !== 12
    ) {
        throw new Error("Invalid Victor manifest");
    }

    const files = new Map<string, VictorFile>();

    for (const asset of data.assets) {
        if (
            !asset ||
            typeof asset.name !== "string" ||
            !asset.name.split("/").every((part: string) => SEGMENT.test(part)) ||
            !Number.isSafeInteger(asset.bytes) ||
            asset.bytes <= 0 ||
            typeof asset.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(asset.sha256) ||
            !CONTENT_TYPES.has(asset.contentType) ||
            files.has(data.bundleBase + asset.name)
        ) {
            throw new Error("Invalid Victor asset");
        }

        files.set(data.bundleBase + asset.name, {
            file: join(root, "vendor", "victor", data.bundle, asset.sha256),
            bytes: asset.bytes,
            sha256: asset.sha256,
            contentType: asset.contentType,
        });
    }

    const { runtime, model, tts } = data;
    const pronunciation = tts?.pronunciation;

    if (
        !runtime ||
        model?.type !== "zipformer2" ||
        !Number.isSafeInteger(model.sampleRate) ||
        model.sampleRate <= 0 ||
        !Number.isSafeInteger(model.featureDim) ||
        model.featureDim <= 0 ||
        tts?.type !== "kitten" ||
        tts.sampleRate !== 24000 ||
        !safePath(tts.dataDir) ||
        !tts.dataDir.startsWith("tts/") ||
        pronunciation?.asset !== "tts/pronunciation.data" ||
        !Array.isArray(pronunciation.files) ||
        pronunciation.files.length === 0
    ) {
        throw new Error("Invalid Victor configuration");
    }

    const expected = [
        [runtime.script, "text/javascript; charset=utf-8", false],
        [runtime.wrapper, "text/javascript; charset=utf-8", false],
        [runtime.wasm, "application/wasm", false],
        [runtime.ttsWrapper, "text/javascript; charset=utf-8", false],
        [model.encoder, "application/octet-stream", false],
        [model.decoder, "application/octet-stream", false],
        [model.joiner, "application/octet-stream", false],
        [model.tokens, "text/plain; charset=utf-8", false],
        [tts.model, "application/octet-stream", true],
        [tts.voices, "application/octet-stream", true],
        [tts.tokens, "application/octet-stream", true],
        [pronunciation.asset, "application/octet-stream", true],
    ] as const;
    const names = new Set<string>();

    for (const [name, contentType, nested] of expected) {
        if (
            !safePath(name) ||
            (nested ? !name.startsWith("tts/") : name.includes("/")) ||
            names.has(name) ||
            files.get(data.bundleBase + name)?.contentType !== contentType
        ) {
            throw new Error("Invalid Victor asset configuration");
        }

        names.add(name);
    }

    const pack = files.get(data.bundleBase + pronunciation.asset)!;
    let end = 0;
    let previous: string | undefined;

    for (const entry of pronunciation.files) {
        if (
            !entry ||
            !safePath(entry.path) ||
            !Number.isSafeInteger(entry.offset) ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 0 ||
            entry.offset !== end ||
            (previous !== undefined && previous >= entry.path)
        ) {
            throw new Error("Invalid Victor pronunciation index");
        }

        const path = tts.dataDir + "/" + entry.path;

        if (names.has(path)) {
            throw new Error("Victor pronunciation file collision");
        }

        names.add(path);
        end += entry.bytes;

        if (!Number.isSafeInteger(end) || end > pack.bytes) {
            throw new Error("Invalid Victor pronunciation range");
        }

        previous = entry.path;
    }

    if (end !== pack.bytes || names.has(tts.dataDir)) {
        throw new Error("Invalid Victor pronunciation layout");
    }

    for (const path of [...names, tts.dataDir]) {
        const parts = path.split("/");

        while (parts.length > 1) {
            parts.pop();

            if (names.has(parts.join("/"))) {
                throw new Error("Victor file/directory collision");
            }
        }
    }

    return { manifest, files };
}

const VICTOR_SCRIPTS = new Set([
    join(APP_ROOT, "web", "victor-worker.js"),
    join(APP_ROOT, "web", "victor-capture-worklet.js"),
]);
/** Workers have their own effective policy; the app page's policy alone does not constrain them. */
const VICTOR_WORKER_CSP = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "connect-src 'self'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
].join("; ");

export function victorScriptPolicy(file: string): Record<string, string> {
    return VICTOR_SCRIPTS.has(file)
        ? {
              "content-security-policy": VICTOR_WORKER_CSP,
              "cross-origin-resource-policy": "same-origin",
          }
        : {};
}

/** A root seam for isolated fixtures; production keeps one successful bundle until restart. */
export function createVictorAssetHandler(root: string = APP_ROOT) {
    let bundle: VictorBundle | undefined;

    return function serveVictorAssets(
        request: IncomingMessage,
        response: ServerResponse,
        path: string,
    ): void {
        if (request.method !== "GET" && request.method !== "HEAD") {
            response.setHeader("allow", "GET, HEAD");

            throw new HttpError(405, "Method not allowed");
        }

        response.setHeader("cross-origin-resource-policy", "same-origin");

        try {
            bundle ??= loadBundle(root);
        } catch {
            throw new HttpError(
                503,
                "Victor manifest is unavailable. Repair Victor assets, then retry.",
            );
        }

        const { manifest, files } = bundle;

        if (path === "/victor-assets/manifest.json") {
            // Keep one uncompressed representation so GET and HEAD advertise the same exact byte length.
            response.writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-cache",
                "content-length": String(Buffer.byteLength(manifest)),
            });
            response.end(request.method === "HEAD" ? undefined : manifest);

            return;
        }

        const asset = files.get(path);

        if (!asset) {
            throw new HttpError(404, "Victor asset not found");
        }

        try {
            const info = statSync(asset.file);

            if (!info.isFile() || info.size !== asset.bytes) {
                throw new Error("incomplete victor asset");
            }
        } catch {
            throw new HttpError(
                503,
                "Victor assets are not prepared. Run node scripts/victor/prepare-victor-assets.mjs, then retry.",
            );
        }

        const etag = `"${asset.sha256}"`;
        const headers = {
            etag,
            "cache-control": "public, max-age=31536000, immutable",
            "content-security-policy": VICTOR_WORKER_CSP,
        };

        if (request.headers["if-none-match"] === etag) {
            response.writeHead(304, headers);
            response.end();

            return;
        }

        response.writeHead(200, {
            ...headers,
            "content-type": asset.contentType,
            "content-length": String(asset.bytes),
        });

        if (request.method === "HEAD") {
            response.end();

            return;
        }

        const stream = createReadStream(asset.file);

        response.once("close", () => stream.destroy());
        stream.on("error", () => response.destroy()).pipe(response);
    };
}

export const serveVictorAssets = createVictorAssetHandler();
