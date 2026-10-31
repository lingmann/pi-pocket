// Victor keeps upstream release notices, but never prepares or installs a release from the app.
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionWeb, PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import createUpdates, { installsByItself } from "../src/server/extensions/updates.ts";
import { Updates, type Release, type UpdatesOptions } from "../src/server/updates.ts";
import { pocketVersion } from "../src/server/versions.ts";

const reason =
    "Self-update is disabled in the Victor fork. Merge upstream changes through the fork workflow.";
const next: Release = {
    tag: "v1.1.0",
    version: "1.1.0",
    name: "Pi Pocket 1.1.0",
    notes: "A new upstream release to review.",
    warning: false,
};
let cases = 0;

after(cleanUp);

function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            HOME: root,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
        },
    }).trim();
}

function fixture() {
    const directory = join(root, `updates-${++cases}`);
    const upstream = join(directory, "upstream");
    const checkout = join(directory, "checkout");

    mkdirSync(upstream, { recursive: true });
    git(upstream, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(upstream, ".gitignore"), "node_modules/\n.pocket-update/\nvendor/\n");
    writeFileSync(join(upstream, "package.json"), JSON.stringify({ version: "1.0.0" }));
    git(upstream, "add", ".");
    git(upstream, "commit", "--quiet", "-m", "initial");
    git(directory, "clone", "--quiet", upstream, checkout);
    writeFileSync(join(upstream, "package.json"), JSON.stringify({ version: next.version }));
    git(upstream, "commit", "--quiet", "-am", "next release");
    git(upstream, "tag", next.tag);
    const target = git(upstream, "rev-parse", "HEAD");

    return { checkout, upstream, target };
}

function updater(appRoot: string, overrides: Partial<UpdatesOptions> = {}) {
    return new Updates({
        appRoot,
        version: "1.0.0",
        repository: "https://github.com/TannerMidd/pi-pocket.git",
        checkOnly: reason,
        supervised: true,
        rollback: true,
        restart: () => assert.fail("a notice must not restart the server"),
        quiesce: () => assert.fail("a notice must not pause reloads"),
        busy: () => 0,
        log: () => assert.fail("a notice must not begin installation"),
        releases: async () => next,
        ...overrides,
    });
}

test("check-only discovery reads GitHub notes without fetching commits or changing the checkout", async (t) => {
    const { checkout, target } = fixture();
    const refs = git(checkout, "show-ref");
    const head = git(checkout, "rev-parse", "HEAD");
    const index = readFileSync(join(checkout, ".git", "index"));
    const requested: string[] = [];

    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
        requested.push(String(url));

        return Response.json({
            tag_name: next.tag,
            name: next.name,
            body: next.notes,
        });
    });
    const updates = updater(checkout, { releases: undefined });

    for (let i = 0; i < 2; i++) {
        const status = await updates.check();

        assert.equal(status.available, true);
        assert.equal(status.latest?.notes, next.notes);
        assert.deepEqual(status.blockers, [reason]);
        assert.deepEqual(status.cautions, []);
        assert.equal(status.packages, false);
        assert.equal(status.commit, head);
        assert.equal(status.branch, "main");
        assert.equal(status.error, undefined);
        assert.equal(installsByItself(status), false);
    }

    assert.deepEqual(
        requested,
        Array(2).fill("https://api.github.com/repos/TannerMidd/pi-pocket/releases/latest"),
    );
    assert.equal(git(checkout, "show-ref"), refs);
    assert.equal(git(checkout, "rev-parse", "HEAD"), head);
    assert.deepEqual(readFileSync(join(checkout, ".git", "index")), index);
    assert.notEqual(spawnSync("git", ["cat-file", "-e", target], { cwd: checkout }).status, 0);
    assert.equal(existsSync(join(checkout, ".git", "FETCH_HEAD")), false);
    assert.equal(existsSync(join(checkout, ".pocket-update")), false);
    assert.equal(existsSync(join(checkout, "node_modules")), false);
});

test("tag-only discovery and a dirty fork remain advisory, without installation blockers or fetches", async () => {
    const { checkout, upstream, target } = fixture();

    writeFileSync(join(checkout, "fork.txt"), "Victor-only commit\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "--quiet", "-m", "fork feature");
    writeFileSync(join(checkout, "fork.txt"), "Uncommitted work\n");
    const before = git(checkout, "status", "--porcelain=v1");
    const updates = updater(checkout, {
        repository: upstream,
        releases: undefined,
        supervised: false,
        rollback: false,
        busy: () => 2,
    });
    const status = await updates.check();

    assert.equal(status.latest?.tag, next.tag);
    assert.equal(status.latest?.notes, undefined);
    assert.equal(status.available, true);
    assert.deepEqual(status.blockers, [reason]);
    assert.deepEqual(status.cautions, []);
    assert.equal(status.error, undefined);
    assert.equal(git(checkout, "status", "--porcelain=v1"), before);
    assert.notEqual(spawnSync("git", ["cat-file", "-e", target], { cwd: checkout }).status, 0);
    assert.equal(existsSync(join(checkout, ".git", "FETCH_HEAD")), false);
});

test("apply refuses before any discovery or side effect, even with every confirmation", async () => {
    const { checkout } = fixture();
    const updates = updater(checkout, {
        releases: async () => assert.fail("apply must refuse before looking for a release"),
    });

    for (const options of [
        {},
        { allowBusy: true, confirmWarning: true, by: "owner", stillWanted: () => undefined },
    ]) {
        await assert.rejects(updates.apply(options), { status: 403, message: reason });
    }

    assert.equal((await updates.status()).step, undefined);
    assert.equal((await updates.status()).checkedAt, undefined);
    assert.equal(existsSync(join(checkout, ".pocket-update")), false);
});

test("check-only status handles current releases and discovery errors without an installation attempt", async () => {
    let latest: Release | undefined = { ...next, version: "1.0.0", tag: "v1.0.0" };
    let failed = false;
    const updates = updater(root, {
        releases: async () => {
            if (failed) {
                throw new Error("release discovery unavailable");
            }

            return latest;
        },
    });

    assert.equal((await updates.check()).available, false);
    latest = undefined;
    assert.equal((await updates.check()).latest, undefined);
    failed = true;
    assert.equal((await updates.check()).error, "release discovery unavailable");
    latest = next;
    failed = false;
    const recovered = await updates.check();

    assert.equal(recovered.error, undefined);
    assert.equal(recovered.available, true);
    assert.deepEqual(recovered.blockers, [reason]);
});

test("the module keeps scheduled checks but hides auto-install and ignores a stale enabled setting", async (t) => {
    const status = await updater(root).check();
    const fields: { name: string }[] = [];
    const dispose: (() => void)[] = [];
    let checks = 0;
    let checking = true;

    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"] });
    createUpdates(
        {
            updates: {
                checkOnly: reason,
                status: async () => status,
                check: async () => {
                    checks++;

                    return status;
                },
                apply: async () => assert.fail("a stale setting must not cause installation"),
                subscribe: () => () => {},
            },
        } as unknown as PocketHost,
        {
            client: () => {},
            settings: (given: { name: string }[]) => fields.push(...given),
            setting: (name: string) => {
                assert.ok(
                    fields.some((field) => field.name === name),
                    `undeclared setting: ${name}`,
                );

                // An old stored auto=true must never be read after its field is removed.
                return name === "check" ? checking : true;
            },
            route: () => {},
            onSettings: () => () => {},
            onDispose: (cleanup: () => void) => dispose.push(cleanup),
        } as unknown as ExtensionWeb,
    );

    try {
        assert.deepEqual(
            fields.map((field) => field.name),
            ["check", "beta"],
        );
        t.mock.timers.tick(2 * 60_000);
        await new Promise(setImmediate);
        assert.equal(checks, 1);
        t.mock.timers.tick(6 * 60 * 60_000);
        await new Promise(setImmediate);
        assert.equal(checks, 2);
        checking = false;
        t.mock.timers.tick(6 * 60 * 60_000);
        await new Promise(setImmediate);
        assert.equal(checks, 2, "turning checks off leaves every timer safe");
    } finally {
        dispose.forEach((cleanup) => cleanup());
    }
});

test("the real app enforces check-only routes and settings through reloads", async () => {
    const app = await openApp(scriptedModel(), join(root, "route-data"));
    const server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => assert.fail("no restart"),
        }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const call = async (path: string, body?: unknown, method = "POST") => {
        const response = await fetch(`${base}${path}`, {
            method: body === undefined ? "GET" : method,
            headers: {
                authorization: `Bearer ${app.config.ownerToken}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        return { status: response.status, data: await response.json() };
    };

    try {
        assert.equal(app.updates.checkOnly, reason);
        assert.equal((await call("/api/x/updates/status")).data.version, pocketVersion());
        await assert.rejects(app.updates.apply(), { status: 403, message: reason });

        for (let attempt = 0; attempt < 2; attempt++) {
            const settings = await call("/api/extension-settings/updates");

            assert.equal(settings.status, 200);
            assert.deepEqual(
                settings.data.fields.map((field: { name: string }) => field.name),
                ["check", "beta"],
            );
            assert.equal(
                (await call("/api/extension-settings/updates", { auto: true }, "PUT")).status,
                400,
            );
            const applied = await call("/api/x/updates/apply", {
                allowBusy: true,
                confirmWarning: true,
            });

            assert.equal(applied.status, 403);
            assert.match(
                JSON.stringify(applied.data),
                /Self-update is disabled in the Victor fork/,
            );
            await app.setExtensionEnabled(owner(app), "updates.ts", false);
            assert.equal((await call("/api/x/updates/status")).status, 404);
            await app.setExtensionEnabled(owner(app), "updates.ts", true);
        }
    } finally {
        server.closeAllConnections();
        server.close();
        await app.close();
    }
});
