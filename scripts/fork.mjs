#!/usr/bin/env node
// Shared-main fork operations. Publication changes tags only; branch changes go through PRs.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";

function run(command, args, capture = false) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(
            capture
                ? result.stderr.trim() || `${command} ${args.join(" ")} failed`
                : `${command} failed (${result.signal ?? result.status})`,
        );
    }

    return capture ? result.stdout.trim() : "";
}

const git = (...args) => run("git", args, true);
const gitOK = (...args) => spawnSync("git", args, { stdio: "ignore" }).status === 0;
const ref = (name) => git("rev-parse", "--verify", name);

function clean() {
    for (const name of [
        "rebase-merge",
        "rebase-apply",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
        "BISECT_LOG",
    ]) {
        if (existsSync(git("rev-parse", "--git-path", name))) {
            throw new Error(`Finish or abort the current Git operation first (${name}).`);
        }
    }

    if (git("status", "--porcelain", "--untracked-files=normal")) {
        throw new Error("Commit or remove working-tree changes first, including untracked files.");
    }
}

function remoteURL(name, push = false) {
    const urls = git("remote", "get-url", ...(push ? ["--push"] : []), "--all", name).split("\n");

    if (urls.length !== 1) {
        throw new Error(`${name} must have exactly one ${push ? "push" : "fetch"} URL.`);
    }

    return urls[0];
}

function repositoryURL(url) {
    return url
        .replace(/^git@([^:]+):/, "https://$1/")
        .replace(/^ssh:\/\/git@/, "https://")
        .replace(/\.git\/?$/, "")
        .replace(/\/$/, "");
}

function mainTracking() {
    if (
        git("config", "--default", "", "--get", "branch.main.remote") !== "origin" ||
        git("config", "--default", "", "--get", "branch.main.merge") !== "refs/heads/main" ||
        git("for-each-ref", "--format=%(upstream)", "refs/heads/main") !==
            "refs/remotes/origin/main"
    ) {
        throw new Error("main must track origin/main.");
    }
}

function context() {
    clean();
    mainTracking();

    if (!gitOK("symbolic-ref", "--quiet", "HEAD")) {
        throw new Error("Check out a branch first; detached HEAD is not supported.");
    }

    const branch = git("symbolic-ref", "--short", "HEAD");
    const originURL = remoteURL("origin");
    const pushURL = remoteURL("origin", true);
    const upstreamURL = remoteURL("upstream");

    if ([originURL, pushURL].some((url) => repositoryURL(url) === repositoryURL(upstreamURL))) {
        throw new Error("origin must point to your fork, not upstream.");
    }

    return { branch, head: ref("HEAD"), originURL, pushURL, upstreamURL };
}

function unchanged(ctx) {
    clean();
    mainTracking();

    if (ref("HEAD") !== ctx.head || git("symbolic-ref", "--short", "HEAD") !== ctx.branch) {
        throw new Error("The checked-out branch or commit changed; start this operation again.");
    }

    if (
        remoteURL("origin") !== ctx.originURL ||
        remoteURL("origin", true) !== ctx.pushURL ||
        remoteURL("upstream") !== ctx.upstreamURL
    ) {
        throw new Error("A remote URL changed; start this operation again.");
    }
}

async function confirm(message) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
        input.once("close", () => resolve(""));
        input.question(`${message}\nType yes to continue: `, resolve);
    });

    input.close();

    if (answer.trim() !== "yes") {
        throw new Error(
            "Cancelled; no branch, commit or tag created. Any completed fetches remain.",
        );
    }
}

function remoteRef(url, name) {
    const output = git("ls-remote", "--refs", "--", url, name);

    return output ? output.split(/\s+/)[0] : "";
}

function fetchMain(remote) {
    // Do not depend on custom fetch mappings or advance any local branch.
    run("git", [
        "fetch",
        "--no-tags",
        "--refmap=",
        remote,
        `refs/heads/main:refs/remotes/${remote}/main`,
    ]);

    return ref(`refs/remotes/${remote}/main`);
}

function availableBranch(ctx, branch) {
    if (
        gitOK("show-ref", "--verify", "--quiet", `refs/heads/${branch}`) ||
        remoteRef(ctx.pushURL, `refs/heads/${branch}`)
    ) {
        throw new Error(`${branch} already exists locally or on origin; choose another name.`);
    }
}

async function upstreamUpdate(name) {
    const branch = `sync/upstream-${name}`;

    if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name ?? "") ||
        !gitOK("check-ref-format", `refs/heads/${branch}`)
    ) {
        throw new Error("Supply a branch label, for example: just upstream-update v0.13.3");
    }

    const ctx = context();

    availableBranch(ctx, branch);

    const forkHead = fetchMain("origin");
    const upstreamHead = fetchMain("upstream");

    if (gitOK("merge-base", "--is-ancestor", upstreamHead, forkHead)) {
        console.log("upstream/main is already included in origin/main; no update branch needed.");

        return;
    }

    await confirm(
        `Create ${branch} and merge upstream into it?\nFork: origin (${ctx.originURL}) at ${forkHead}\nUpstream: ${ctx.upstreamURL} at ${upstreamHead}\nThis switches files and may leave merge conflicts. Use a development checkout, not a serving checkout. Nothing will be pushed.`,
    );
    unchanged(ctx);
    availableBranch(ctx, branch);
    run("git", ["switch", "--no-track", "-c", branch, forkHead]);

    try {
        run("git", [
            "merge",
            "--no-ff",
            "--no-edit",
            "--no-squash",
            "-m",
            `Merge upstream/main into ${branch}`,
            upstreamHead,
        ]);
    } catch (error) {
        console.error(
            "Resolve and stage conflicts, then run git merge --continue; or git merge --abort. The update branch and fetched refs remain.",
        );

        throw error;
    }

    console.log(
        `Run just check, push ${branch}, and open a PR to the fork's main. Use Create a merge commit for this PR, never squash.`,
    );
}

function check() {
    console.log(
        "Checking TypeScript, Victor, fork tooling, dictation, worker registration and notifications.",
    );
    run("npm", ["run", "check"]);

    const tests = readdirSync("test")
        .filter((name) => /^victor-.*\.test\.ts$/.test(name))
        .sort()
        .map((name) => `test/${name}`);

    run(process.execPath, [
        "--test",
        ...tests,
        "test/fork-workflow.test.ts",
        "test/voice.test.ts",
        "test/service-worker.test.ts",
        "test/notify.test.ts",
    ]);
    console.log(
        "Automated checks passed. Broader upstream integration tests and physical-device audio checks remain manual; see docs/victor.md and TEST_ISSUES.md.",
    );
}

function releaseMain(ctx) {
    if (ref("refs/remotes/origin/main") !== ctx.head) {
        throw new Error(
            "Local main must match fetched origin/main. Update with git pull --ff-only; do not push local main commits.",
        );
    }

    for (const url of new Set([ctx.originURL, ctx.pushURL])) {
        if (remoteRef(url, "refs/heads/main") !== ctx.head) {
            throw new Error(
                "Origin's main changed or the push destination has a different main. Review and update before releasing.",
            );
        }
    }
}

async function release(version) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "")) {
        throw new Error("Use a release version X.Y.Z, for example: just release 0.1.0");
    }

    const ctx = context();
    const tag = `victor/v${version}`;

    if (ctx.branch !== "main") {
        throw new Error("Release from the fork's shared main, not a feature or update branch.");
    }

    if (
        gitOK("show-ref", "--verify", "--quiet", `refs/tags/${tag}`) ||
        remoteRef(ctx.pushURL, `refs/tags/${tag}`)
    ) {
        throw new Error(`${tag} already exists. Published versions are never replaced.`);
    }

    fetchMain("origin");
    releaseMain(ctx);
    await confirm(
        `Check and publish ${tag}?\nFork main: ${ctx.head}\nDestination: origin (${ctx.pushURL})\nConfirm only after the required manual release checks. Only the new tag will be pushed; this does not deploy.`,
    );
    unchanged(ctx);
    check();
    unchanged(ctx);
    releaseMain(ctx);
    run("git", [
        "tag",
        "-a",
        tag,
        ctx.head,
        "-m",
        `Victor ${version}\n\nFork main: ${ctx.head}\nAutomated checks: just check`,
    ]);

    try {
        unchanged(ctx);
        run("git", ["push", "--no-follow-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);

        if (remoteRef(ctx.pushURL, `refs/tags/${tag}`) !== ref(`refs/tags/${tag}`)) {
            throw new Error("Remote tag verification failed.");
        }
    } catch (error) {
        console.error(
            `Local tag ${tag} is preserved. Verify the destination and resolve the error, then retry:\n  git push --no-follow-tags origin refs/tags/${tag}:refs/tags/${tag}`,
        );

        throw error;
    }

    console.log(`Published ${tag} at ${ctx.head}. Main is unchanged.`);
}

function status() {
    process.env.GIT_PAGER = "cat";

    run("git", ["status", "--short", "--branch"]);
    run("git", ["branch", "-vv"]);
    run("git", ["remote", "-v"]);

    const history = gitOK("show-ref", "--verify", "--quiet", "refs/remotes/origin/main")
        ? "refs/remotes/origin/main"
        : "refs/heads/main";
    const latest = git(
        "for-each-ref",
        "--sort=-creatordate",
        "--count=1",
        "--format=%(refname:short)",
        "refs/tags/victor/",
    );

    console.log(
        `\nLatest local release tag: ${latest || "(none)"}\nFork main first-parent history (${history}; no fetch):`,
    );
    run("git", ["log", "--first-parent", "--oneline", "--decorate", "-12", history]);
}

try {
    const [action, argument, ...extra] = process.argv.slice(2);
    const actions = { status, check, "upstream-update": upstreamUpdate, release };

    if (
        !Object.hasOwn(actions, action ?? "") ||
        extra.length ||
        (argument !== undefined && !["upstream-update", "release"].includes(action))
    ) {
        throw new Error(
            "Usage: node scripts/fork.mjs status|check|upstream-update NAME|release VERSION",
        );
    }

    process.chdir(git("rev-parse", "--show-toplevel"));
    await actions[action](argument);
} catch (error) {
    console.error(`fork: ${error.message}`);
    process.exitCode = 1;
}
