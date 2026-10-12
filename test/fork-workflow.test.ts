// Real Git integration: disposable file-only remotes, isolated configuration, no app or branchless.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../scripts/fork.mjs", import.meta.url));
const updateBranch = "sync/upstream-next";
const tag = "victor/v1.2.3";
const tagRef = `refs/tags/${tag}`;
const mutations = ["upstream-update", "release"];
const focusedTests = [
    "victor-alpha.test.ts",
    "victor-newly-added.test.ts",
    "fork-workflow.test.ts",
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
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
appendFileSync(process.env.FORK_TEST_RECORD, 'check:' + git('rev-parse', 'HEAD') + '\\n');
if (process.env.FORK_TEST_FAIL_CHECK) process.exit(1);
if (process.env.FORK_TEST_CHANGE === 'dirty') writeFileSync('unexpected.txt', 'changed during check');
if (process.env.FORK_TEST_CHANGE === 'head') git('commit', '--allow-empty', '-m', 'changed during check');
if (process.env.FORK_TEST_CHANGE === 'branch') git('switch', '-c', 'feature/changed');
if (process.env.FORK_TEST_CHANGE === 'pushurl') git('remote', 'set-url', '--push', 'origin', process.env.FORK_TEST_URL);
if (process.env.FORK_TEST_CHANGE === 'fetchurl') git('remote', 'set-url', 'origin', process.env.FORK_TEST_URL);
if (process.env.FORK_TEST_CHANGE === 'tracking') git('config', 'branch.main.remote', 'upstream');
if (process.env.FORK_TEST_CHANGE === 'remote-tag') git('push', process.env.FORK_TEST_REMOTE, process.env.FORK_TEST_BASE + ':refs/tags/victor/v1.2.3');
if (process.env.FORK_TEST_CHANGE === 'remote-main') git('--git-dir=' + process.env.FORK_TEST_REMOTE, 'update-ref', 'refs/heads/main', process.env.FORK_TEST_BASE);
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

test("status is read-only on dirty detached HEAD, with origin first-parent history and local fallback", (t) => {
    const f = fixture(t);

    f.git("tag", "-a", "victor/v0.1.0", "-m", "local release");
    f.git("switch", "--detach");
    f.put("work.txt", "dirty\n");
    const before = f.snapshot();
    const result = f.run("status", undefined, "");

    success(result);
    assert.match(result.output, /work\.txt/);
    assert.match(result.output, /victor\/v0\.1\.0/);
    assert.match(result.output, /fork change/);
    assert.deepEqual(f.snapshot(), before);
    f.git("update-ref", "-d", "refs/remotes/origin/main");
    success(f.run("status", undefined, ""));
    const calls = f.gitCalls();
    const logs = calls.filter((args) => args.includes("log"));

    assert.equal(logs.length, 2);
    assert.ok(logs.every((args) => args.includes("--first-parent")));
    assert.ok(logs[0]!.some((arg) => /^(refs\/remotes\/)?origin\/main$/.test(arg)));
    assert.ok(logs[1]!.some((arg) => /^(refs\/heads\/)?main$/.test(arg)));
    assert.equal(
        calls.some((args) => args.includes("fetch")),
        false,
    );
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
        failure(f.run("upstream-update", name));
    }

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

    failure(f.run("upstream-update", "next", "yes\n", ["extra"]));
    failure(f.run("release", "1.2.3", "yes\n", ["extra"]));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(existsSync(f.record), false);
    assertNoPublish(f.gitCalls());
});

test("both mutations reject dirty, detached and unfinished states before fetching", async (t) => {
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

test("duplicate update branches are refused locally and at the actual push endpoint", (t) => {
    const f = fixture(t);

    f.advanceUpstream();
    f.git("branch", updateBranch);
    let before = f.protectedState();

    failure(f.run("upstream-update", "next"));
    assert.deepEqual(f.protectedState(), before);
    f.git("branch", "-D", updateBranch);
    const destination = f.bare("push-only");

    f.git("push", destination, `HEAD:refs/heads/${updateBranch}`);
    f.git("remote", "set-url", "--push", "origin", destination);
    before = f.protectedState();
    const remoteBefore = f.refs(destination);

    failure(f.run("upstream-update", "next"));
    assert.deepEqual(f.protectedState(), before);
    assert.equal(f.refs(destination), remoteBefore);
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

test("prompt-time checkout, URL and tracking drift is rejected by both mutations", async (t) => {
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
                assert.equal(existsSync(f.record), false);
            });
        }
    }
});

test("upstream update pins fetched OIDs even if tracking refs move during confirmation", async (t) => {
    const f = fixture(t);
    const upstreamTip = f.advanceUpstream();
    const result = await f.duringPrompt("upstream-update", "next", () => {
        f.git("update-ref", "refs/remotes/origin/main", f.base);
        f.git("update-ref", "refs/remotes/upstream/main", f.base);
    });

    success(result);
    assert.deepEqual(f.git("show", "-s", "--format=%P", "HEAD").split(" "), [f.fork, upstreamTip]);
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

test("release fetches main even without its tracking ref and publishes only the checked annotated tag", (t) => {
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
    f.assertChecks();
    f.assertPublishedTag();
    assert.ok(result.output.includes(f.fork), result.output);
    assert.ok(result.output.includes(f.origin), result.output);
    const annotation = f.git("for-each-ref", "--format=%(contents)", tagRef);

    assert.ok(annotation.includes(f.fork), annotation);
    assert.match(annotation, /just check/);
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

test("failed type checks or focused tests never create or publish a release tag", (t) => {
    const f = fixture(t);
    const before = f.protectedState();

    f.env.FORK_TEST_FAIL_CHECK = "1";
    failure(f.run("release", "1.2.3"));
    assert.equal(readFileSync(f.record, "utf8"), `check:${f.head()}\n`);
    assert.deepEqual(f.protectedState(), before);
    delete f.env.FORK_TEST_FAIL_CHECK;
    f.env.FORK_TEST_FAIL_TEST = "victor-newly-added.test.ts";
    const result = f.run("release", "1.2.3");

    failure(result);
    assert.match(result.output, /fixture test failure/);
    assert.deepEqual(f.protectedState(), before);
});

test("release revalidates branch, HEAD, cleanliness, URLs and tracking after checks", async (t) => {
    for (const change of ["branch", "head", "dirty", "pushurl", "fetchurl", "tracking"]) {
        await t.test(change, (t) => {
            const f = fixture(t);
            const other = f.bare("other");
            const before = f.refs(f.origin);

            f.env.FORK_TEST_URL = other;
            f.env.FORK_TEST_CHANGE = change;
            failure(f.run("release", "1.2.3"));
            assert.ok(readFileSync(f.record, "utf8").includes("victor-newly-added.test.ts"));
            assert.equal(f.refs(f.repo, "refs/tags"), "");
            assert.equal(f.refs(f.origin), before);
            assert.equal(f.refs(other), "");
        });
    }
});

test("release freshly queries both fetch and push main after checks, not cached tracking refs", async (t) => {
    for (const changedRemote of ["fetch", "push"]) {
        await t.test(changedRemote, (t) => {
            const f = fixture(t);
            const destination = f.bare("push-only");

            f.git("push", destination, "main:refs/heads/main");
            f.git("remote", "set-url", "--push", "origin", destination);
            f.env.FORK_TEST_CHANGE = "remote-main";
            f.env.FORK_TEST_REMOTE = changedRemote === "fetch" ? f.origin : destination;
            f.env.FORK_TEST_BASE = f.base;
            failure(f.run("release", "1.2.3"));
            f.assertChecks();
            assert.equal(f.git("rev-parse", "origin/main"), f.fork);
            assert.equal(f.refs(f.repo, "refs/tags"), "");
            assert.equal(f.refs(f.origin, "refs/tags"), "");
            assert.equal(f.refs(destination, "refs/tags"), "");
            assert.equal(f.gitAt(f.env.FORK_TEST_REMOTE, "rev-parse", "main"), f.base);
        });
    }
});

test("a remote tag race during checks cannot be overwritten by forced wildcard push rules", (t) => {
    const f = fixture(t);
    const before = f.refs(f.origin, "refs/heads");

    f.git("config", "remote.origin.push", "+refs/tags/*:refs/tags/*");
    f.env.FORK_TEST_CHANGE = "remote-tag";
    f.env.FORK_TEST_REMOTE = f.origin;
    f.env.FORK_TEST_BASE = f.base;
    const result = f.run("release", "1.2.3");

    failure(result);
    f.assertChecks();
    assert.equal(f.gitAt(f.origin, "rev-parse", tagRef), f.base);
    assert.equal(f.gitAt(f.origin, "tag", "--list"), tag);
    assert.equal(f.refs(f.origin, "refs/heads"), before);
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
