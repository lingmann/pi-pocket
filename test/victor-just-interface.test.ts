import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}) {
    const cwd = mkdtempSync(join(tmpdir(), "victor-just-"));
    const bin = join(cwd, "bin");
    const script = join(cwd, "scripts/victor/fork.mjs");
    const trace = join(cwd, "commands.log");

    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(bin);
    copyFileSync(new URL("../justfile", import.meta.url), join(cwd, "justfile"));

    for (const name of ["fork.mjs", "prepare-victor-assets.mjs"]) {
        writeFileSync(
            join(dirname(script), name),
            `import { appendFileSync } from "node:fs";
appendFileSync(process.env.COMMAND_TRACE, "task\\n");
console.log(JSON.stringify(process.argv.slice(2)));
`,
        );
    }

    for (const name of ["git", "gh", "npm", "tailscale"]) {
        writeFileSync(join(bin, name), '#!/bin/sh\necho called >> "$COMMAND_TRACE"\nexit 1\n', {
            mode: 0o755,
        });
    }

    function run(...args: string[]) {
        const result = spawnSync("just", args, {
            cwd,
            env: {
                ...env,
                PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
                HOME: cwd,
                COMMAND_TRACE: trace,
                TAILSCALE_BIN: join(bin, "tailscale"),
            },
            encoding: "utf8",
            timeout: 10_000,
        });

        assert.ifError(result.error);

        return result;
    }

    return { cwd, bin, script, trace, run };
}

test("Just lists real inputs and describes them through native usage without running tasks", (t) => {
    const f = fixture(t);
    const listing = f.run();

    assert.equal(listing.status, 0, listing.stderr);
    assert.doesNotMatch(listing.stdout, /\*(args|options)/);
    assert.match(listing.stdout, /dev\s+.*Tailscale HTTPS.*8444/);

    for (const [recipe, detail] of [
        ["feature", "Branch suffix"],
        ["upstream-update", "Branch label"],
        ["pr", "Quoted PR description"],
        ["release", "X.Y.Z"],
    ] as const) {
        const result = f.run("--usage", recipe);

        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.startsWith(`Usage: just ${recipe}`));
        assert.ok(result.stdout.includes(detail), result.stdout);
        assert.equal(result.stderr, "");
    }

    for (const recipe of [
        "check",
        "repo-status",
        "prepare-victor",
        "start",
        "start-local",
        "dev",
    ]) {
        const result = f.run("--usage", recipe);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), `Usage: just ${recipe}`);
        assert.equal(result.stderr, "");
    }

    assert.equal(existsSync(f.trace), false);
});

test("Just forwards quoted and default arguments and rejects missing or unknown recipe inputs", (t) => {
    const f = fixture(t);
    const description = 'fix "quotes", apostrophe\'s, spaces and $variables';

    for (const [args, forwarded] of [
        [["check"], ["check"]],
        [["repo-status"], ["status"]],
        [["prepare-victor"], []],
        [
            ["feature", "voice-fix"],
            ["feature", "voice-fix"],
        ],
        [
            ["upstream-update", "next"],
            ["upstream-update", "next"],
        ],
        [
            ["release", "1.2.3"],
            ["release", "1.2.3"],
        ],
        [["pr"], ["pr", ""]],
        [
            ["pr", description],
            ["pr", description],
        ],
    ] as const) {
        const result = f.run(...args);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), forwarded);
    }

    for (const args of [
        ["release"],
        ["release", "asdf", "asdf"],
        ["check", "--help"],
        ["dev", "--help"],
        ["check", "release"],
        ["check", "unknown"],
    ]) {
        rmSync(f.trace, { force: true });
        const result = f.run(...args);

        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /error:/);
        assert.equal(existsSync(f.trace), false, result.stderr);
    }
});

test("Just dev keeps Pocket data and ports separate and forwards working directories", (t) => {
    for (const workspace of [undefined, "/tmp/dev workspace's folder"]) {
        const f = fixture(t, {
            PI_POCKET_HOST: "0.0.0.0",
            PI_POCKET_PORT: "8787",
            PI_POCKET_DIR: "/production/pocket",
            PI_POCKET_CWD: workspace,
        });

        for (const name of ["npm", "tailscale"]) {
            writeFileSync(
                join(f.bin, name),
                `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,
                { mode: 0o755 },
            );
        }

        const result = f.run("dev");

        assert.equal(result.status, 0, result.stderr);
        const [, served, launched] = result.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));

        assert.deepEqual(served, ["serve", "--bg", "--https=8444", "http://127.0.0.1:8788"]);
        assert.deepEqual(launched, [
            "start",
            "--",
            "--access",
            "local",
            "--host",
            "127.0.0.1",
            "--port",
            "8788",
            "--data",
            join(f.cwd, ".pi-pocket-dev"),
            "--cwd",
            workspace ?? realpathSync(f.cwd),
        ]);
    }
});

test("Just dev does not launch Pocket if Tailscale setup fails", (t) => {
    const f = fixture(t);
    const result = f.run("dev");

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Use a unique browser profile/);
    assert.equal(readFileSync(f.trace, "utf8"), "task\ncalled\n");
});

test("Just consumes optional arguments before selecting subsequent recipes", (t) => {
    const f = fixture(t);

    for (const [args, invocations] of [
        [
            ["check", "repo-status"],
            [["check"], ["status"]],
        ],
        [["pr", "check"], [["pr", "check"]]],
        [
            ["pr", "", "check"],
            [["pr", ""], ["check"]],
        ],
    ] as const) {
        const result = f.run(...args);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(
            result.stdout
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line)),
            invocations,
        );
    }
});

test("Just forwards unsupported options to the real fork script without reaching Git or GitHub", (t) => {
    const f = fixture(t);

    copyFileSync(new URL("../scripts/victor/fork.mjs", import.meta.url), f.script);

    for (const recipe of ["feature", "upstream-update", "pr", "release"]) {
        for (const flag of ["-h", "--help", "--unknown", "  --help", "\t- fix bug"]) {
            const result = f.run(recipe, flag);

            assert.equal(result.status, 1);
            assert.equal(result.stdout, "");
            assert.notEqual(result.stderr.trim(), "");
            assert.equal(existsSync(f.trace), false, result.stderr);
        }
    }
});
