// Real Git integration: disposable file-only remotes, isolated configuration, no app or branchless.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../scripts/victor/fork.mjs", import.meta.url));
const updateBranch = "sync/upstream-next";
const featureBranch = "fixture/next";
const tag = "victor/v1.2.3";
const tagRef = `refs/tags/${tag}`;
const existingForkPR = JSON.stringify([
    {
        url: "existing PR",
        baseRefName: "main",
        headRepositoryOwner: { login: "lingmann" },
        headRepository: { name: "pi-pocket" },
    },
]);
const mutations = ["feature", "upstream-update", "release"];
const focusedTests = [
    "victor-alpha.test.ts",
    "victor-newly-added.test.ts",
    "victor-fork-workflow.test.ts",
    "victor-fork-pr-title.test.ts",
    "service-worker.test.ts",
    "notify.test.ts",
    "voice.test.ts",
];

type Result = { status: number | null; output: string };

function success(result: Result) {
    assert.equal(result.status, 0, result.output);
}

function failure(result: Result) {
    assert.notEqual(result.status, null, `process did not exit normally: ${result.output}`);
    assert.notEqual(result.status, 0, result.output);
}

function fixture(t: TestContext) {
    const root = mkdtempSync(join(tmpdir(), "fork-workflow-"));
    const repo = join(root, "work");
    const origin = join(root, "origin.git");
    const upstream = join(root, "upstream.git");
    const home = join(root, "home");
    const empty = join(root, "empty");
    const record = join(root, "checks.log");
    const trace = join(root, "git-trace.jsonl");

    t.after(() => rmSync(root, { recursive: true, force: true }));

    for (const path of [repo, home, empty]) {
        mkdirSync(path);
    }

    const env: NodeJS.ProcessEnv = {
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        USER: "fixture",
        XDG_CONFIG_HOME: home,
        TMPDIR: root,
        LANG: "C",
        TZ: "UTC",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: empty,
        GIT_CONFIG_KEY_1: "commit.gpgSign",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "tag.gpgSign",
        GIT_CONFIG_VALUE_2: "false",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        GIT_EDITOR: "true",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "file",
        npm_config_userconfig: "/dev/null",
        npm_config_globalconfig: join(home, "npm-global-config"),
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
        FORK_TEST_RECORD: record,
    };

    function gitAt(cwd: string, ...args: string[]) {
        const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });

        assert.ifError(result.error);
        assert.equal(result.status, 0, `git ${args.join(" ")}\n${result.stdout}${result.stderr}`);

        return result.stdout.trim();
    }

    const git = (...args: string[]) => gitAt(repo, ...args);
    const put = (path: string, content: string) => writeFileSync(join(repo, path), content);
    const head = () => git("rev-parse", "HEAD");
    const refs = (cwd = repo, namespace = "refs") =>
        gitAt(cwd, "for-each-ref", "--format=%(refname) %(objectname)", namespace);
    const snapshot = () => ({
        head: head(),
        branch: git("branch", "--show-current"),
        refs: refs(),
        origin: refs(origin),
        upstream: refs(upstream),
        status: git("status", "--porcelain=v1", "--untracked-files=all"),
    });
    // Fetches may change tracking refs on cancellation, but never these local/published refs.
    const protectedState = () => ({
        head: head(),
        branch: git("branch", "--show-current"),
        branches: refs(repo, "refs/heads"),
        tags: refs(repo, "refs/tags"),
        origin: refs(origin),
        upstream: refs(upstream),
    });

    function run(action: string, argument?: string, input = "yes\n", extra: string[] = []) {
        const result = spawnSync(
            process.execPath,
            [helper, action, ...(argument === undefined ? [] : [argument]), ...extra],
            {
                cwd: repo,
                env: { ...env, GIT_TRACE2_EVENT: trace },
                encoding: "utf8",
                input,
                timeout: 20_000,
            },
        );

        assert.ifError(result.error);

        return { status: result.status, output: result.stdout + result.stderr };
    }

    async function duringPrompt(action: string, argument: string, change: () => void) {
        const child = spawn(process.execPath, [helper, action, argument], {
            cwd: repo,
            env: { ...env, GIT_TRACE2_EVENT: trace },
            stdio: "pipe",
        });
        let output = "";
        let changed = false;

        t.after(() => {
            if (child.exitCode === null) {
                child.kill();
            }
        });
        const result = await new Promise<Result>((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`confirmation was never reached:\n${output}`));
            }, 15_000);

            const receive = (chunk: Buffer) => {
                output += chunk.toString();

                if (!changed && /Type yes/i.test(output)) {
                    changed = true;

                    try {
                        change();
                        child.stdin.end("yes\n");
                    } catch (error) {
                        child.kill();
                        clearTimeout(timer);
                        reject(error);
                    }
                }
            };

            child.stdout.on("data", receive);
            child.stderr.on("data", receive);
            child.on("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.on("close", (status) => {
                clearTimeout(timer);
                resolve({ status, output });
            });
        });

        assert.equal(changed, true, result.output);

        return result;
    }

    function commit(message: string) {
        git("add", ".");
        git("commit", "-m", message);

        return head();
    }

    function bare(name: string) {
        const path = join(root, `${name}.git`);

        gitAt(root, "init", "--bare", "--initial-branch=main", `--template=${empty}`, path);

        return path;
    }

    function advanceUpstream(conflict = false) {
        const writer = join(root, "upstream-writer");

        gitAt(root, "clone", `--template=${empty}`, upstream, writer);
        writeFileSync(join(writer, conflict ? "work.txt" : "upstream.txt"), "upstream change\n");
        gitAt(writer, "add", ".");
        gitAt(writer, "commit", "-m", "new upstream commit");
        gitAt(writer, "push", "origin", "main:refs/heads/main");

        return gitAt(writer, "rev-parse", "HEAD");
    }

    function gitCalls() {
        if (!existsSync(trace)) {
            return [];
        }

        return readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
            .filter((event) => event.event === "start")
            .map((event) => event.argv!);
    }

    function setupPR() {
        const bin = join(root, "bin");
        const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
        const ghRecord = join(root, "gh.jsonl");

        mkdirSync(bin);
        // Only presentation is mocked. All Git mutations still use file-only remotes.
        writeFileSync(
            join(bin, "git"),
            `#!${process.execPath}\n
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const r = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' });
let out = r.stdout || '';
if (args[0] === 'remote' && args[1] === 'get-url' && args.at(-1) === 'origin') {
    out = out.replaceAll(${JSON.stringify(origin)}, 'https://github.com/lingmann/pi-pocket.git');
}
process.stdout.write(out); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 1);
`,
        );
        writeFileSync(
            join(bin, "gh"),
            `#!${process.execPath}\n
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[args.indexOf('--repo') + 1] !== 'github.com/lingmann/pi-pocket') throw new Error('GitHub host must be explicit');
appendFileSync(${JSON.stringify(ghRecord)}, JSON.stringify(args) + '\\n');
if (args[0] === 'auth' && process.env.FORK_TEST_AUTH_FAIL) process.exit(1);
if (args[1] === 'list') {
    if (args[args.indexOf('--head') + 1].includes(':')) throw new Error('gh pr list does not accept owner:branch');
    if (process.env.FORK_TEST_LIST_FAIL) process.exit(1);
    console.log(process.env.FORK_TEST_EXISTING_PR || '[]');
}
if (args[1] === 'create') {
    if (process.env.FORK_TEST_CREATE_FAIL) process.exit(1);
    console.log('https://github.com/lingmann/pi-pocket/pull/123');
}
`,
        );

        for (const name of ["git", "gh"]) {
            chmodSync(join(bin, name), 0o755);
        }

        env.PATH = `${bin}:${env.PATH}`;

        return () =>
            existsSync(ghRecord)
                ? readFileSync(ghRecord, "utf8")
                      .trim()
                      .split("\n")
                      .map((line) => JSON.parse(line) as string[])
                : [];
    }

    function assertChecks(checked = head()) {
        assert.deepEqual(
            readFileSync(record, "utf8").trim().split("\n").sort(),
            [`check:${checked}`, ...focusedTests].sort(),
        );
    }

    function assertPublishedTag(checked = head(), destination = origin) {
        assert.equal(git("cat-file", "-t", tagRef), "tag");
        assert.equal(git("rev-parse", `${tagRef}^{commit}`), checked);
        assert.equal(gitAt(destination, "rev-parse", tagRef), git("rev-parse", tagRef));
    }

    git("init", "--initial-branch=main", `--template=${empty}`);
    bare("origin");
    bare("upstream");
    mkdirSync(join(repo, "test"));
    put("package.json", JSON.stringify({ type: "module", scripts: { check: "node check.mjs" } }));
    put(
        "check.mjs",
        `
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
appendFileSync(process.env.FORK_TEST_RECORD, 'check:' + git('rev-parse', 'HEAD') + '\\n');
if (process.env.FORK_TEST_FAIL_CHECK) process.exit(1);
`,
    );

    for (const name of focusedTests) {
        put(
            `test/${name}`,
            `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FORK_TEST_RECORD, ${JSON.stringify(name + "\n")});
if (process.env.FORK_TEST_FAIL_TEST === ${JSON.stringify(name)}) throw new Error('fixture test failure');
`,
        );
    }

    put("test/unrelated.test.ts", "throw new Error('unrelated suite must not run');\n");
    put("work.txt", "base\n");
    const base = commit("upstream base");

    git("remote", "add", "upstream", upstream);
    git("remote", "add", "origin", origin);
    git("remote", "set-url", "--push", "origin", origin);
    git("push", "upstream", "main:refs/heads/main");
    put("work.txt", "fork change\n");
    const fork = commit("fork change");

    git("push", "--set-upstream", "origin", "main:refs/heads/main");

    return {
        root,
        repo,
        origin,
        upstream,
        env,
        record,
        base,
        fork,
        git,
        gitAt,
        put,
        head,
        refs,
        snapshot,
        protectedState,
        run,
        duringPrompt,
        commit,
        bare,
        advanceUpstream,
        gitCalls,
        setupPR,
        assertChecks,
        assertPublishedTag,
    };
}

function assertFetches(calls: string[][], remotes: string[]) {
    const fetches = calls.filter((args) => args.includes("fetch"));

    assert.equal(fetches.length, remotes.length, JSON.stringify(fetches));

    for (const remote of remotes) {
        const args = fetches.find((args) => args.includes(remote));

        assert.ok(args, `missing ${remote} fetch`);
        assert.ok(args.includes("--no-tags"), JSON.stringify(args));
        assert.ok(
            args.some(
                (arg) => arg.replace(/^\+/, "") === `refs/heads/main:refs/remotes/${remote}/main`,
            ),
            JSON.stringify(args),
        );
    }
}

function assertNoPublish(calls: string[][]) {
    assert.equal(
        calls.some((args) => args.includes("push") || args.includes("branchless")),
        false,
    );
}

test("fork script rejects malformed input and unsupported options before running Git or GitHub", (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "fork-usage-"));
    const trace = join(cwd, "commands.log");

    t.after(() => rmSync(cwd, { recursive: true, force: true }));

    for (const name of ["git", "gh"]) {
        writeFileSync(join(cwd, name), '#!/bin/sh\necho called >> "$COMMAND_TRACE"\nexit 1\n', {
            mode: 0o755,
        });
    }

    for (const args of [
        [],
        ["unknown"],
        ["check", "status"],
        ["status", "extra"],
        ["feature"],
        ["upstream-update"],
        ["release"],
        ["feature", "one", "two"],
        ["upstream-update", "one", "two"],
        ["pr", "one", "two"],
        ["release", "1.2.3", "extra"],
        ["--help"],
        ["pr", "  --help"],
        ["pr", "-description"],
        ["pr", "description", "--help"],
        ...["status", "check", "feature", "upstream-update", "pr", "release"].flatMap((action) =>
            ["-h", "--help", "--unknown"].map((flag) => [action, flag]),
        ),
    ]) {
        const result = spawnSync(process.execPath, [helper, ...args], {
            cwd,
            env: { ...process.env, PATH: cwd, COMMAND_TRACE: trace },
            encoding: "utf8",
            timeout: 10_000,
        });

        assert.ifError(result.error);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.notEqual(result.stderr.trim(), "");
        assert.equal(existsSync(trace), false, result.stderr);
    }
});

test("upstream update previews only incoming workflow changes before confirmation", (t) => {
    const f = fixture(t);
    const writer = join(f.root, "workflow-writer");
    const workflows = ".github/workflows";

    f.gitAt(f.root, "clone", f.upstream, writer);
    mkdirSync(join(writer, workflows), { recursive: true });

    for (const name of ["edit", "delete", "rename"]) {
        writeFileSync(join(writer, workflows, `${name}.yml`), `name: ${name}\n`);
    }

    f.gitAt(writer, "add", ".");
    f.gitAt(writer, "commit", "-m", "shared workflows");
    f.gitAt(writer, "push", "origin", "main");
    f.git("fetch", "upstream");
    f.git("merge", "--no-edit", "upstream/main");
    f.put(`${workflows}/fork-only.yml`, "name: fork-only\n");
    f.commit("fork-only workflow");
    f.git("push", "origin", "main");

    writeFileSync(join(writer, workflows, "edit.yml"), "name: edited\n");
    writeFileSync(join(writer, workflows, "added.yml"), "name: added\n");
    writeFileSync(join(writer, "unrelated.txt"), "unrelated content\n");
    f.gitAt(writer, "rm", `${workflows}/delete.yml`);
    f.gitAt(writer, "mv", `${workflows}/rename.yml`, `${workflows}/renamed.yml`);
    f.gitAt(writer, "add", ".");
    f.gitAt(writer, "commit", "-m", "upstream workflow changes");
    f.gitAt(writer, "push", "origin", "main");
    f.git("config", "color.ui", "always");
    const result = f.run("upstream-update", "next", "no\n");

    failure(result);
    const prompt = result.output.indexOf("Type yes");

    assert.ok(prompt >= 0, result.output);
    const preview = result.output.slice(0, prompt);

    for (const expected of [
        "=== INCOMING WORKFLOW CHANGES ===",
        `A\t${workflows}/added.yml`,
        `D\t${workflows}/delete.yml`,
        `M\t${workflows}/edit.yml`,
        `R100\t${workflows}/rename.yml\t${workflows}/renamed.yml`,
        "diff --git",
        "+name: added",
        "-name: delete",
        "+name: edited",
        `rename to ${workflows}/renamed.yml`,
    ]) {
        assert.ok(
            preview.includes(expected),
            `Missing ${expected} before confirmation:\n${preview}`,
        );
    }

    assert.doesNotMatch(preview, /fork-only|unrelated content|\x1b\[/);
});

test("upstream update stays quiet about workflows when only other files change", (t) => {
    const f = fixture(t);

    f.advanceUpstream();
    const result = f.run("upstream-update", "next");

    success(result);
    assert.doesNotMatch(result.output, /INCOMING WORKFLOW CHANGES|diff --git/);
});

test("status fetches upstream without changing dirty detached HEAD, with origin history and local fallback", (t) => {
    const f = fixture(t);

    f.git("tag", "-a", "victor/v0.1.0", "-m", "local release");
    f.git("switch", "--detach");
    f.put("work.txt", "dirty\n");
    const before = f.protectedState();
    const worktree = f.git("status", "--porcelain=v1");
    const result = f.run("status", undefined, "");

    success(result);
    assert.match(result.output, /work\.txt/);
    assert.match(result.output, /victor\/v0\.1\.0/);
    assert.match(result.output, /fork change/);
    assert.match(result.output, /UPSTREAM AHEAD/);
    assert.match(result.output, /RECENT FORK HISTORY/);
    assert.match(result.output, /LOCAL CHANGES/);
    assert.match(result.output, /HEAD detached/);
    assert.deepEqual(f.protectedState(), before);
    assert.equal(f.git("status", "--porcelain=v1"), worktree);
    f.git("update-ref", "-d", "refs/remotes/origin/main");
    success(f.run("status", undefined, ""));
    const calls = f.gitCalls();
    const logs = calls.filter((args) => args.includes("log"));

    assert.ok(logs.every((args) => args.includes("--first-parent")));
    const histories = logs.filter((args) => args.includes("-12"));

    assert.equal(histories.length, 2);
    assert.ok(histories[0]!.includes("refs/remotes/origin/main"));
    assert.ok(histories[1]!.includes("refs/heads/main"));
    const fetches = calls.filter((args) => args.includes("fetch"));

    assert.equal(fetches.length, 2);

    for (const fetch of fetches) {
        assertFetches([fetch], ["upstream"]);
    }

    assertNoPublish(calls);
});

test("check discovers only focused suites without confirmation or Git mutation", (t) => {
    const f = fixture(t);
    const before = f.snapshot();

    success(f.run("check", undefined, ""));
    f.assertChecks();
    assert.deepEqual(f.snapshot(), before);
});

test("invalid commands, argument counts, names and versions never mutate refs", (t) => {
    const f = fixture(t);
    const before = f.snapshot();

    for (const action of ["backup", "rebase", "push", "unknown"]) {
        failure(f.run(action));
    }

    for (const action of ["status", "check"]) {
        failure(f.run(action, "extra"));
    }

    for (const name of [
        undefined,
        "",
        "-bad",
        "a/b",
        "a b",
        "a..b",
        "a.lock",
        "a.",
        "a@{b",
        "../bad",
    ]) {
        for (const action of ["feature", "upstream-update"]) {
            failure(f.run(action, name));
        }
    }

    for (const user of [undefined, "", "../bad", "a/b", "a b", "a..b", "a.lock"]) {
        if (user === undefined) {
            delete f.env.USER;
        } else {
            f.env.USER = user;
        }

        failure(f.run("feature", "next"));
    }

    f.env.USER = "sync";
    failure(f.run("feature", "upstream-next"));
    f.env.USER = "fixture";

    for (const version of [
        undefined,
        "",
        "v1.2.3",
        "1.2",
        "01.2.3",
        "1.2.3-beta",
        "1.2.3+build",
        "../bad",
    ]) {
        failure(f.run("release", version));
    }

    failure(f.run("feature", "next", "yes\n", ["extra"]));
    failure(f.run("upstream-update", "next", "yes\n", ["extra"]));
    failure(f.run("release", "1.2.3", "yes\n", ["extra"]));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(existsSync(f.record), false);
    assertNoPublish(f.gitCalls());
});

test("mutations reject dirty, detached and unfinished states before fetching", async (t) => {
    const states = [
        "detached",
        "unstaged",
        "staged",
        "untracked",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
        "sequencer",
        "BISECT_LOG",
    ];

    for (const state of states) {
        await t.test(state, (t) => {
            const f = fixture(t);

            if (state === "detached") {
                f.git("switch", "--detach");
            } else if (["unstaged", "staged", "untracked"].includes(state)) {
                f.put(state === "untracked" ? "new.txt" : "work.txt", "dirty\n");

                if (state === "staged") {
                    f.git("add", "work.txt");
                }
            } else if (["rebase-merge", "rebase-apply", "sequencer"].includes(state)) {
                mkdirSync(join(f.repo, ".git", state));
            } else {
                writeFileSync(join(f.repo, ".git", state), f.base + "\n");
            }

            const before = f.snapshot();

            for (const action of mutations) {
                failure(f.run(action, action === "release" ? "1.2.3" : "next"));
            }

            assert.deepEqual(f.snapshot(), before);
            assert.equal(
                f.gitCalls().some((args) => args.includes("fetch")),
                false,
            );
            assert.equal(existsSync(f.record), false);
        });
    }
});

test("main must track origin/main without implicit reconfiguration", (t) => {
    const f = fixture(t);

    f.git("config", "branch.main.remote", "upstream");
    const before = f.snapshot();

    for (const action of mutations) {
        const result = f.run(action, action === "release" ? "1.2.3" : "next");

        failure(result);
        assert.match(result.output, /main must track origin\/main/);
    }

    assert.equal(f.git("config", "branch.main.remote"), "upstream");
    assert.deepEqual(f.snapshot(), before);
});

test("a local-dot tracking configuration cannot masquerade as tracking origin/main", (t) => {
    const f = fixture(t);

    f.git("config", "branch.main.remote", ".");
    f.git("config", "branch.main.merge", "refs/remotes/origin/main");
    assert.equal(
        f.git("for-each-ref", "--format=%(upstream)", "refs/heads/main"),
        "refs/remotes/origin/main",
    );
    const before = f.snapshot();

    for (const action of mutations) {
        const result = f.run(action, action === "release" ? "1.2.3" : "next");

        failure(result);
        assert.match(result.output, /origin\/main/);
    }

    assert.deepEqual(f.snapshot(), before);
    assert.equal(
        f.gitCalls().some((args) => args.includes("fetch")),
        false,
    );
});

test("origin has one fetch and push URL, each distinct from upstream", async (t) => {
    for (const mode of ["fetch-upstream", "push-upstream", "multiple-fetch", "multiple-push"]) {
        await t.test(mode, (t) => {
            const f = fixture(t);

            if (mode === "fetch-upstream") {
                f.git("remote", "set-url", "origin", f.upstream);
            } else if (mode === "push-upstream") {
                f.git("remote", "set-url", "--push", "origin", f.upstream);
            } else {
                f.git(
                    "remote",
                    "set-url",
                    "--add",
                    ...(mode === "multiple-push" ? ["--push"] : []),
                    "origin",
                    f.upstream,
                );
            }

            const before = f.snapshot();

            for (const action of mutations) {
                failure(f.run(action, action === "release" ? "1.2.3" : "next"));
            }

            assert.deepEqual(f.snapshot(), before);
            assert.equal(
                f.gitCalls().some((args) => args.includes("fetch") || args.includes("ls-remote")),
                false,
            );
        });
    }
});

test("feature branches use USER and fetched fork main, not stale main or unrelated HEAD", (t) => {
    const f = fixture(t);

    f.git("switch", "-c", "feature/unrelated");
    f.put("unrelated.txt", "not part of the new feature\n");
    const unrelated = f.commit("unrelated local feature");

    f.git("update-ref", "refs/heads/main", f.base);
    f.git("update-ref", "refs/remotes/origin/main", f.base);
    f.git("config", "branch.autoSetupMerge", "always");
    f.git("config", "--add", "remote.origin.fetch", "refs/heads/main:refs/heads/main");
    f.gitAt(f.origin, "tag", "remote-only", "main");
    const before = { origin: f.refs(f.origin), upstream: f.refs(f.upstream) };
    const result = f.run("feature", "next");

    success(result);
    assert.equal(f.git("branch", "--show-current"), featureBranch);
    assert.equal(f.head(), f.fork);
    assert.equal(f.git("rev-parse", "main"), f.base);
    assert.equal(f.git("rev-parse", "feature/unrelated"), unrelated);
    assert.equal(f.git("for-each-ref", "--format=%(upstream)", `refs/heads/${featureBranch}`), "");
    assert.equal(f.refs(f.repo, "refs/tags"), "");
    assert.equal(existsSync(join(f.repo, "unrelated.txt")), false);
    assert.deepEqual({ origin: f.refs(f.origin), upstream: f.refs(f.upstream) }, before);
    assert.ok(result.output.includes(featureBranch), result.output);
    assertFetches(f.gitCalls(), ["origin"]);
    assertNoPublish(f.gitCalls());
});

test("upstream update merges fetched tips, retaining fork history despite stale main and another HEAD", (t) => {
    const f = fixture(t);
    const upstreamTip = f.advanceUpstream();

    f.git("switch", "-c", "feature/unrelated");
    f.put("unrelated.txt", "not part of update\n");
    const unrelated = f.commit("unrelated local feature");

    f.git("update-ref", "refs/heads/main", f.base);
    f.git("update-ref", "refs/remotes/origin/main", f.base);
    f.git("config", "merge.ff", "only");
    f.git("config", `branch.${updateBranch}.mergeOptions`, "--ff-only --squash");
    f.git("config", "branch.autoSetupMerge", "always");
    // Extra configured fetch rules must not replace explicit main refspecs or fetch tags.
    f.git(
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/not-main:refs/remotes/origin/not-main",
    );
    f.git(
        "config",
        "--add",
        "remote.upstream.fetch",
        "+refs/heads/not-main:refs/remotes/upstream/not-main",
    );
    f.gitAt(f.origin, "tag", "remote-only", "main");
    const before = { origin: f.refs(f.origin), upstream: f.refs(f.upstream) };
    const result = f.run("upstream-update", "next");

    success(result);
    assert.equal(f.git("branch", "--show-current"), updateBranch);
    assert.equal(f.git("rev-parse", "main"), f.base);
    assert.equal(f.git("rev-parse", "feature/unrelated"), unrelated);
    assert.deepEqual(f.git("show", "-s", "--format=%P", "HEAD").split(" "), [f.fork, upstreamTip]);
    assert.equal(f.git("show", "HEAD:work.txt"), "fork change");
    assert.equal(f.git("show", "HEAD:upstream.txt"), "upstream change");
    assert.equal(existsSync(join(f.repo, "unrelated.txt")), false);
    assert.equal(f.git("for-each-ref", "--format=%(upstream)", `refs/heads/${updateBranch}`), "");
    assert.equal(f.refs(f.repo, "refs/tags"), "");
    assert.deepEqual({ origin: f.refs(f.origin), upstream: f.refs(f.upstream) }, before);

    for (const value of [updateBranch, f.fork, upstreamTip, f.origin, f.upstream]) {
        assert.ok(result.output.includes(value), result.output);
    }

    const calls = f.gitCalls();
    const merge = calls.find((args) => args.includes("merge") && args.includes("-m"));

    assert.ok(merge, JSON.stringify(calls));

    for (const value of ["--no-ff", "--no-edit", "--no-squash", upstreamTip]) {
        assert.ok(merge.includes(value), JSON.stringify(merge));
    }

    assertFetches(calls, ["origin", "upstream"]);
    assertNoPublish(calls);
});

test("configured fetch mappings cannot advance local main, including on cancellation", async (t) => {
    for (const input of ["yes\n", "no\n"]) {
        await t.test(input.trim(), (t) => {
            const f = fixture(t);

            f.advanceUpstream();
            f.git("switch", "-c", "feature/local");
            f.git("update-ref", "refs/heads/main", f.base);
            f.git("config", "--add", "remote.origin.fetch", "refs/heads/main:refs/heads/main");
            const before = f.protectedState();
            const result = f.run("upstream-update", "next", input);

            if (input === "yes\n") {
                success(result);
                assert.equal(f.git("branch", "--show-current"), updateBranch);
                assert.equal(f.git("rev-parse", "HEAD^1"), f.fork);
            } else {
                assert.deepEqual(f.protectedState(), before);
            }

            assert.equal(f.git("rev-parse", "main"), f.base);
            assert.equal(f.git("rev-parse", "origin/main"), f.fork);
            assertNoPublish(f.gitCalls());
        });
    }
});

test("even a fast-forwardable upstream update has two parents", (t) => {
    const f = fixture(t);
    const upstreamTip = f.advanceUpstream();

    f.git("reset", "--hard", f.base);
    f.gitAt(f.origin, "update-ref", "refs/heads/main", f.base);
    f.git("update-ref", "refs/remotes/origin/main", f.base);
    f.git("config", "merge.ff", "only");
    f.git("config", `branch.${updateBranch}.mergeOptions`, "--ff-only --squash");
    success(f.run("upstream-update", "next"));
    assert.deepEqual(f.git("show", "-s", "--format=%P", "HEAD").split(" "), [f.base, upstreamTip]);
    assert.equal(f.git("rev-parse", "main"), f.base);
});

test("failed main fetches stop before confirmation, checkout or publication", async (t) => {
    for (const [action, remote] of [
        ["feature", "origin"],
        ["upstream-update", "origin"],
        ["upstream-update", "upstream"],
        ["release", "origin"],
    ] as const) {
        await t.test(`${action}: ${remote}`, (t) => {
            const f = fixture(t);

            f.gitAt(
                remote === "origin" ? f.origin : f.upstream,
                "update-ref",
                "-d",
                "refs/heads/main",
            );
            const before = f.protectedState();
            const result = f.run(action, action === "release" ? "1.2.3" : "next");

            failure(result);
            assert.doesNotMatch(result.output, /Type yes/i);
            assert.deepEqual(f.protectedState(), before);
            assert.equal(existsSync(f.record), false);
            assertNoPublish(f.gitCalls());
        });
    }
});

test("already-integrated upstream is a no-op without confirmation", (t) => {
    const f = fixture(t);
    const before = f.protectedState();

    success(f.run("upstream-update", "next", ""));
    assert.deepEqual(f.protectedState(), before);
    assertNoPublish(f.gitCalls());
});

test("duplicate branches are refused locally and at the actual push endpoint", async (t) => {
    for (const [action, branch] of [
        ["feature", featureBranch],
        ["upstream-update", updateBranch],
    ] as const) {
        await t.test(action, (t) => {
            const f = fixture(t);

            f.advanceUpstream();
            f.git("branch", branch);
            let before = f.protectedState();

            failure(f.run(action, "next"));
            assert.deepEqual(f.protectedState(), before);
            f.git("branch", "-D", branch);
            const destination = f.bare("push-only");

            f.git("push", destination, `HEAD:refs/heads/${branch}`);
            f.git("remote", "set-url", "--push", "origin", destination);
            before = f.protectedState();
            const remoteBefore = f.refs(destination);

            failure(f.run(action, "next"));
            assert.deepEqual(f.protectedState(), before);
            assert.equal(f.refs(destination), remoteBefore);
        });
    }
});

test("cancellation after fetching requires literal yes and creates no branch, tag or commit", (t) => {
    const f = fixture(t);

    f.advanceUpstream();
    const before = f.protectedState();

    for (const action of mutations) {
        for (const input of ["", "y\n", "YES\n", "no\n"]) {
            const result = f.run(action, action === "release" ? "1.2.3" : "next", input);

            assert.match(result.output, /yes/i);
            assert.deepEqual(f.protectedState(), before);
            assert.equal(existsSync(f.record), false);
        }
    }

    assert.equal(f.git("rev-parse", "upstream/main"), f.gitAt(f.upstream, "rev-parse", "main"));
    assertNoPublish(f.gitCalls());
});

test("prompt-time checkout, URL and tracking drift is rejected by mutations", async (t) => {
    for (const action of mutations) {
        for (const change of [
            "branch",
            "head",
            "dirty",
            "fetchurl",
            "pushurl",
            "upstreamurl",
            "tracking",
        ]) {
            await t.test(`${action}: ${change}`, async (t) => {
                const f = fixture(t);
                const other = f.bare("other");

                f.advanceUpstream();
                const originBefore = f.refs(f.origin);
                const result = await f.duringPrompt(
                    action,
                    action === "release" ? "1.2.3" : "next",
                    () => {
                        if (change === "branch") {
                            f.git("switch", "-c", "feature/changed");
                        } else if (change === "head") {
                            f.git("commit", "--allow-empty", "-m", "changed while confirming");
                        } else if (change === "dirty") {
                            f.put("unexpected.txt", "changed\n");
                        } else if (change === "tracking") {
                            f.git("config", "branch.main.remote", "upstream");
                        } else {
                            f.git(
                                "remote",
                                "set-url",
                                ...(change === "pushurl" ? ["--push"] : []),
                                change === "upstreamurl" ? "upstream" : "origin",
                                other,
                            );
                        }
                    },
                );

                failure(result);
                assert.equal(f.refs(f.origin), originBefore);
                assert.equal(f.refs(other), "");
                assert.equal(f.refs(f.repo, "refs/tags"), "");
                assert.equal(f.refs(f.repo, `refs/heads/${updateBranch}`), "");
                assert.equal(f.refs(f.repo, `refs/heads/${featureBranch}`), "");
                assert.equal(existsSync(f.record), false);
            });
        }
    }
});

test("branch creation pins fetched OIDs even if tracking refs move during confirmation", async (t) => {
    for (const action of ["feature", "upstream-update"]) {
        await t.test(action, async (t) => {
            const f = fixture(t);
            const upstreamTip = f.advanceUpstream();
            const result = await f.duringPrompt(action, "next", () => {
                f.git("update-ref", "refs/remotes/origin/main", f.base);
                f.git("update-ref", "refs/remotes/upstream/main", f.base);
            });

            success(result);

            if (action === "feature") {
                assert.equal(f.head(), f.fork);
            } else {
                assert.deepEqual(f.git("show", "-s", "--format=%P", "HEAD").split(" "), [
                    f.fork,
                    upstreamTip,
                ]);
            }
        });
    }
});

test("conflicts stay on the update branch for ordinary merge continue or abort", async (t) => {
    for (const resolution of ["continue", "abort"]) {
        await t.test(resolution, (t) => {
            const f = fixture(t);
            const upstreamTip = f.advanceUpstream(true);
            const before = f.refs(f.origin);
            const result = f.run("upstream-update", "next");

            failure(result);
            assert.match(result.output, /git merge --continue/);
            assert.match(result.output, /git merge --abort/);
            assert.equal(f.git("branch", "--show-current"), updateBranch);
            assert.equal(f.git("rev-parse", "MERGE_HEAD"), upstreamTip);
            assert.equal(f.git("rev-parse", "main"), f.fork);

            if (resolution === "continue") {
                f.put("work.txt", "fork and upstream resolved\n");
                f.git("add", "work.txt");
                f.git("merge", "--continue");
                assert.deepEqual(f.git("show", "-s", "--format=%P", "HEAD").split(" "), [
                    f.fork,
                    upstreamTip,
                ]);
            } else {
                f.git("merge", "--abort");
                assert.equal(f.head(), f.fork);
                assert.equal(f.git("rev-parse", "upstream/main"), upstreamTip);
            }

            assert.equal(f.git("branch", "--show-current"), updateBranch);
            assert.equal(f.git("status", "--porcelain"), "");
            assert.equal(f.refs(f.origin), before);
            assertNoPublish(f.gitCalls());
        });
    }
});

test("release fetches main even without its tracking ref and publishes only the annotated tag without local checks", (t) => {
    const f = fixture(t);
    const before = f.refs(f.origin, "refs/heads");

    f.git("update-ref", "-d", "refs/remotes/origin/main");
    f.git(
        "config",
        "--add",
        "remote.origin.fetch",
        "+refs/heads/not-main:refs/remotes/origin/not-main",
    );
    f.git("config", "push.followTags", "true");
    f.git("config", "remote.origin.push", "+refs/tags/*:refs/tags/redirected/*");
    f.git("tag", "-a", "unrelated", "-m", "must stay local");
    const result = f.run("release", "1.2.3");

    success(result);
    assert.equal(existsSync(f.record), false);
    f.assertPublishedTag();
    assert.ok(result.output.includes(f.fork), result.output);
    assert.ok(result.output.includes(f.origin), result.output);
    const annotation = f.git("for-each-ref", "--format=%(contents)", tagRef);

    assert.ok(annotation.includes(f.fork), annotation);
    assert.doesNotMatch(annotation, /Automated checks|just check/);
    assert.equal(f.refs(f.origin, "refs/heads"), before);
    assert.equal(f.gitAt(f.origin, "tag", "--list"), tag);
    const calls = f.gitCalls();
    const pushes = calls.filter((args) => args.includes("push"));

    assertFetches(calls, ["origin"]);
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0]!.includes("--no-follow-tags"));
    assert.ok(pushes[0]!.includes(`${tagRef}:${tagRef}`));
    assert.equal(
        pushes[0]!.some(
            (arg) =>
                arg.startsWith("+") || arg.startsWith("--force") || arg.startsWith("refs/heads/"),
        ),
        false,
    );
});

test("release requires main to equal both freshly fetched and actual push-endpoint main", async (t) => {
    for (const state of ["feature", "ahead", "behind", "push-mismatch", "push-missing"]) {
        await t.test(state, (t) => {
            const f = fixture(t);

            if (state === "feature") {
                f.git("switch", "-c", "feature/not-main");
            } else if (state === "ahead") {
                f.git("commit", "--allow-empty", "-m", "not published");
            } else if (state === "behind") {
                const ahead = f.git(
                    "commit-tree",
                    "HEAD^{tree}",
                    "-p",
                    "HEAD",
                    "-m",
                    "remote advance",
                );

                f.git("push", "origin", `${ahead}:refs/heads/main`);
                // A stale tracking ref must not satisfy the release guard.
                f.git("update-ref", "refs/remotes/origin/main", f.fork);
            } else {
                const destination = f.bare("push-only");

                if (state === "push-mismatch") {
                    f.git("push", destination, `${f.base}:refs/heads/main`);
                }

                f.git("remote", "set-url", "--push", "origin", destination);
            }

            const before = f.protectedState();

            failure(f.run("release", "1.2.3"));
            assert.deepEqual(f.protectedState(), before);
            assert.equal(existsSync(f.record), false);
        });
    }
});

test("local and actual push-endpoint duplicate versions are never replaced", (t) => {
    const f = fixture(t);
    const destination = f.bare("push-only");

    f.git("push", destination, "main:refs/heads/main");
    f.git("remote", "set-url", "--push", "origin", destination);
    f.git("tag", "-a", tag, "-m", "local duplicate");
    failure(f.run("release", "1.2.3"));
    assert.equal(f.refs(destination, "refs/tags"), "");
    f.git("push", destination, `${tagRef}:${tagRef}`);
    const original = f.git("rev-parse", tagRef);

    f.git("tag", "-d", tag);
    failure(f.run("release", "1.2.3"));
    assert.equal(f.refs(f.repo, "refs/tags"), "");
    assert.equal(f.gitAt(destination, "rev-parse", tagRef), original);
    assert.equal(existsSync(f.record), false);
});

test("release does not invoke type checks or focused tests even when their stand-ins would fail", (t) => {
    const f = fixture(t);

    f.env.FORK_TEST_FAIL_CHECK = "1";
    f.env.FORK_TEST_FAIL_TEST = "victor-newly-added.test.ts";
    success(f.run("release", "1.2.3"));
    assert.equal(existsSync(f.record), false);
    f.assertPublishedTag();
});

test("release freshly queries both fetch and push main after confirmation, not cached tracking refs", async (t) => {
    for (const changedRemote of ["fetch", "push"]) {
        await t.test(changedRemote, async (t) => {
            const f = fixture(t);
            const destination = f.bare("push-only");

            f.git("push", destination, "main:refs/heads/main");
            f.git("remote", "set-url", "--push", "origin", destination);
            const remote = changedRemote === "fetch" ? f.origin : destination;
            const result = await f.duringPrompt("release", "1.2.3", () => {
                f.gitAt(remote, "update-ref", "refs/heads/main", f.base);
            });

            failure(result);
            assert.equal(existsSync(f.record), false);
            assert.equal(f.git("rev-parse", "origin/main"), f.fork);
            assert.equal(f.refs(f.repo, "refs/tags"), "");
            assert.equal(f.refs(f.origin, "refs/tags"), "");
            assert.equal(f.refs(destination, "refs/tags"), "");
            assert.equal(f.gitAt(remote, "rev-parse", "main"), f.base);
        });
    }
});

test("a remote tag race during confirmation cannot be overwritten by forced wildcard push rules", async (t) => {
    const f = fixture(t);
    const before = f.refs(f.origin, "refs/heads");

    f.git("config", "remote.origin.push", "+refs/tags/*:refs/tags/*");
    const result = await f.duringPrompt("release", "1.2.3", () => {
        f.git("push", f.origin, `${f.base}:${tagRef}`);
    });

    failure(result);
    assert.equal(existsSync(f.record), false);
    assert.equal(f.gitAt(f.origin, "rev-parse", tagRef), f.base);
    assert.equal(f.gitAt(f.origin, "tag", "--list"), tag);
    assert.equal(f.refs(f.origin, "refs/heads"), before);
});

test("PR publication pins only the feature branch and uses explicit fork metadata", (t) => {
    const f = fixture(t);
    const ghCalls = f.setupPR();

    f.git("switch", "-c", "feature/voice");
    f.git("commit", "--allow-empty", "-m", "voice fix");
    f.git("config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
    f.git("config", "push.followTags", "true");
    f.git("tag", "-a", "unrelated", "-m", "stay local");
    const head = f.head();

    f.env.FORK_TEST_EXISTING_PR = JSON.stringify([
        {
            url: "other owner's PR",
            headRepositoryOwner: { login: "other" },
            headRepository: { name: "pi-pocket" },
        },
    ]);
    const result = f.run("pr", "fork: fix voice playback");

    success(result);
    assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/voice"), head);
    assert.equal(f.git("config", "branch.feature/voice.remote"), "origin");
    assert.equal(f.git("config", "branch.feature/voice.merge"), "refs/heads/feature/voice");
    assert.equal(f.gitAt(f.origin, "rev-parse", "main"), f.fork);
    assert.equal(f.refs(f.origin, "refs/tags"), "");
    assert.deepEqual(ghCalls().at(-1), [
        "pr",
        "create",
        "--repo",
        "github.com/lingmann/pi-pocket",
        "--base",
        "main",
        "--head",
        "lingmann:feature/voice",
        "--title",
        "fork: fix voice playback",
        "--body",
        "fix voice playback",
    ]);
    const pushes = f.gitCalls().filter((args) => args.includes("push"));

    assert.equal(pushes.length, 1);
    assert.deepEqual(pushes[0]!.slice(1), [
        "push",
        "--no-follow-tags",
        "origin",
        `${head}:refs/heads/feature/voice`,
    ]);
});

test("upstream merge and PR titles use imported ancestry after later fixes and ref movement", (t) => {
    const f = fixture(t);
    const imported = f.advanceUpstream();

    success(f.run("upstream-update", "next"));
    assert.equal(
        f.git("show", "-s", "--format=%s", "HEAD"),
        `upstream: merge upstream/main (${imported})`,
    );
    f.git("commit", "--allow-empty", "-m", "later fix");
    f.git("update-ref", "refs/remotes/upstream/main", f.base);
    const ghCalls = f.setupPR();

    success(f.run("pr", ""));
    assert.ok(ghCalls().at(-1)!.includes(`upstream: merge upstream/main (${imported})`));
});

test("PR preflight and cancellation never publish", async (t) => {
    for (const state of [
        "main",
        "dirty",
        "detached",
        "auth",
        "list",
        "existing",
        "cancel",
        "fetchurl",
        "pushurl",
        "mirror",
        "no-import",
        "empty-description",
        "wrong-prefix",
    ]) {
        await t.test(state, (t) => {
            const f = fixture(t);
            const ghCalls = f.setupPR();

            if (state !== "main") {
                f.git("switch", "-c", state === "no-import" ? updateBranch : "feature/guard");
                f.git("commit", "--allow-empty", "-m", "feature");
            }

            if (state === "dirty") {
                f.put("unexpected.txt", "dirty");
            }

            if (state === "detached") {
                f.git("checkout", "--detach");
            }

            if (state === "auth") {
                f.env.FORK_TEST_AUTH_FAIL = "1";
            }

            if (state === "list") {
                f.env.FORK_TEST_LIST_FAIL = "1";
            }

            if (state === "existing") {
                f.env.FORK_TEST_EXISTING_PR = existingForkPR;
            }

            if (state === "mirror") {
                f.git("config", "remote.origin.mirror", "true");
            }

            if (state === "fetchurl" || state === "pushurl") {
                f.git(
                    "remote",
                    "set-url",
                    ...(state === "pushurl" ? ["--push"] : []),
                    "origin",
                    "https://github.com/other/pi-pocket.git",
                );
            }

            const before = f.protectedState();
            const result = f.run(
                "pr",
                state === "empty-description"
                    ? " "
                    : state === "wrong-prefix"
                      ? "upstream: fake import"
                      : "guard",
                state === "cancel" ? "no\n" : "yes\n",
            );

            if (state === "existing") {
                success(result);
            } else {
                failure(result);
            }

            assert.deepEqual(f.protectedState(), before);
            assertNoPublish(f.gitCalls());
            assert.equal(
                ghCalls().some((args) => args[1] === "create"),
                false,
            );
        });
    }
});

test("PR rejects prompt-time context drift before publishing", async (t) => {
    for (const change of ["branch", "head", "dirty", "fetchurl", "pushurl", "tracking", "mirror"]) {
        await t.test(change, async (t) => {
            const f = fixture(t);

            f.setupPR();
            f.git("switch", "-c", "feature/guard");
            f.git("commit", "--allow-empty", "-m", "feature");
            const before = f.refs(f.origin);
            const result = await f.duringPrompt("pr", "guard", () => {
                if (change === "branch") {
                    f.git("switch", "-c", "feature/changed");
                } else if (change === "head") {
                    f.git("commit", "--allow-empty", "-m", "changed");
                } else if (change === "dirty") {
                    f.put("unexpected.txt", "dirty");
                } else if (change === "tracking") {
                    f.git("config", "branch.main.remote", "upstream");
                } else if (change === "mirror") {
                    f.git("config", "remote.origin.mirror", "true");
                } else {
                    f.git(
                        "remote",
                        "set-url",
                        ...(change === "pushurl" ? ["--push"] : []),
                        "origin",
                        "https://github.com/other/pi-pocket.git",
                    );
                }
            });

            failure(result);
            assert.equal(f.refs(f.origin), before);
            assertNoPublish(f.gitCalls());
        });
    }
});

test("a failed PR create preserves the published branch and retries without duplicates", (t) => {
    const f = fixture(t);
    const ghCalls = f.setupPR();

    f.git("switch", "-c", "feature/retry");
    f.git("commit", "--allow-empty", "-m", "feature");
    f.env.FORK_TEST_CREATE_FAIL = "1";
    const result = f.run("pr", "retry safely");

    failure(result);
    assert.match(result.output, /was pushed.*Retry just pr/s);
    assert.equal(f.gitAt(f.origin, "rev-parse", "feature/retry"), f.head());
    assert.equal(f.git("config", "branch.feature/retry.remote"), "origin");
    assert.equal(f.git("config", "branch.feature/retry.merge"), "refs/heads/feature/retry");
    delete f.env.FORK_TEST_CREATE_FAIL;
    f.env.FORK_TEST_EXISTING_PR = existingForkPR;
    success(f.run("pr", "retry safely"));
    assert.equal(ghCalls().filter((args) => args[1] === "create").length, 1);
    assert.equal(f.gitCalls().filter((args) => args.includes("push")).length, 1);
});

test("failed tag publication preserves the annotated tag with an exact safe retry command", (t) => {
    const f = fixture(t);
    const before = f.refs(f.origin, "refs/heads");

    f.git("config", "remote.origin.push", "+refs/tags/*:refs/tags/redirected/*");
    f.gitAt(f.origin, "config", "receive.hideRefs", "refs/tags");
    const result = f.run("release", "1.2.3");

    failure(result);
    assert.equal(f.git("cat-file", "-t", tagRef), "tag");
    assert.equal(f.git("rev-parse", `${tagRef}^{commit}`), f.fork);
    assert.equal(f.refs(f.origin, "refs/tags"), "");
    const object = f.git("rev-parse", tagRef);
    const refspec = `${tagRef}:${tagRef}`;

    assert.ok(result.output.includes(`git push --no-follow-tags origin ${refspec}`), result.output);
    f.gitAt(f.origin, "config", "--unset", "receive.hideRefs");
    f.git("push", "--no-follow-tags", "origin", refspec);
    f.assertPublishedTag();
    assert.equal(f.git("rev-parse", tagRef), object);
    assert.equal(f.refs(f.origin, "refs/heads"), before);
});
