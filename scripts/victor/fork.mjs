#!/usr/bin/env node
// Shared-main fork operations. Branch changes reach main only through PRs.
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

function fetchMain(remote, capture = false) {
    // Do not depend on custom fetch mappings or advance any local branch.
    run(
        "git",
        ["fetch", "--no-tags", "--refmap=", remote, `refs/heads/main:refs/remotes/${remote}/main`],
        capture,
    );

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

async function feature(slug) {
    const user = process.env.USER ?? "";
    const branch = `${user}/${slug ?? ""}`;

    if (
        [user, slug ?? ""].some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
        branch.startsWith("sync/upstream-") ||
        !gitOK("check-ref-format", `refs/heads/${branch}`)
    ) {
        throw new Error("Set USER to a valid namespace and supply a slug: just feature voice-fix");
    }

    const ctx = context();

    availableBranch(ctx, branch);
    const forkHead = fetchMain("origin");

    await confirm(
        `Create ${branch} from origin/main at ${forkHead}?\nFork: ${ctx.originURL}\nThis switches files. Use a development checkout, not a serving checkout. Nothing will be pushed.`,
    );
    unchanged(ctx);
    availableBranch(ctx, branch);
    run("git", ["switch", "--no-track", "-c", branch, forkHead]);
    console.log(
        'Make, review and test changes, then commit them and run just pr "description". Use Squash and merge for the PR.',
    );
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

    // Compare with the common ancestor so fork-only edits are not shown as incoming changes.
    const workflowDiff = [
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        `${forkHead}...${upstreamHead}`,
        "--",
        ".github/workflows/",
    ];
    const workflows = git("diff", "--no-color", "--name-status", ...workflowDiff);

    if (workflows) {
        console.log("\n=== INCOMING WORKFLOW CHANGES ===\n");
        console.log(workflows);
        console.log();
        const color = process.stdout.isTTY && !Object.hasOwn(process.env, "NO_COLOR");

        console.log(git("diff", `--color=${color ? "always" : "never"}`, ...workflowDiff));
        console.log("\n=== END WORKFLOW CHANGES ===\n");
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
            upstreamTitle(upstreamHead),
            upstreamHead,
        ]);
    } catch (error) {
        console.error(
            "Resolve and stage conflicts, then run git merge --continue; or git merge --abort. The update branch and fetched refs remain.",
        );

        throw error;
    }

    console.log(
        `Review and test the update separately, then run just pr to publish ${branch} and open a PR to the fork's main. Use Create a merge commit for this PR, never squash.`,
    );
}

const forkRepository = "github.com/lingmann/pi-pocket";
const upstreamTitle = (sha) => `upstream: merge upstream/main (${sha})`;

function publicationDestination(ctx) {
    if (
        [ctx.originURL, ctx.pushURL].some(
            (url) => repositoryURL(url).toLowerCase() !== `https://${forkRepository}`,
        )
    ) {
        throw new Error(
            `origin fetch and push URLs must both identify GitHub repository ${forkRepository}.`,
        );
    }

    if (git("config", "--bool", "--default", "false", "--get", "remote.origin.mirror") === "true") {
        throw new Error("Disable remote.origin.mirror before publishing.");
    }
}

function prTitle(ctx, description, base) {
    if (!ctx.branch.startsWith("sync/upstream-")) {
        return `fork: ${description}`;
    }

    // The oldest first-parent merge on this branch records the imported commit.
    // Later fixes (and a moving upstream/main) must not change its identity.
    const merges = git(
        "rev-list",
        "--first-parent",
        "--merges",
        "--reverse",
        `${base}..${ctx.head}`,
    )
        .split("\n")
        .filter(Boolean);
    const parents = merges.length ? git("show", "-s", "--format=%P", merges[0]).split(" ") : [];

    if (parents.length !== 2 || !gitOK("merge-base", "--is-ancestor", parents[0], base)) {
        throw new Error(
            "Cannot identify the upstream import: expected a two-parent merge directly from fork main. Review the branch ancestry.",
        );
    }

    return upstreamTitle(parents[1]);
}

function existingPR(branch, pushed = false) {
    const prs = JSON.parse(
        run(
            "gh",
            [
                "pr",
                "list",
                "--repo",
                forkRepository,
                "--head",
                branch,
                "--state",
                "open",
                "--json",
                "url,baseRefName,headRepositoryOwner,headRepository",
            ],
            true,
        ),
    );

    const matches = prs.filter(
        (pr) =>
            pr.headRepositoryOwner?.login?.toLowerCase() === "lingmann" &&
            pr.headRepository?.name?.toLowerCase() === "pi-pocket",
    );

    if (matches.length) {
        console.log(
            `An open PR already exists: ${matches.map((pr) => pr.url).join(", ")}. ${pushed ? "The branch was pushed; no duplicate PR was created." : "No branch was pushed and no PR was created."} Review the existing PR instead.`,
        );

        return true;
    }

    return false;
}

async function pr(description = "") {
    if (/[\r\n\x00-\x1f\x7f]/.test(description)) {
        throw new Error(
            'Supply a single-line description, for example: just pr "fix voice playback"',
        );
    }

    const ctx = context();

    description = description.trim();

    if (!ctx.branch.startsWith("sync/upstream-")) {
        description = description.replace(/^fork:\s*/, "");

        if (!description || /^upstream:/.test(description)) {
            throw new Error('Supply a fork description, for example: just pr "fix voice playback"');
        }
    }

    if (ctx.branch === "main") {
        throw new Error("Create PRs from a feature or upstream-update branch, never main.");
    }

    publicationDestination(ctx);
    run("gh", ["auth", "status", "--hostname", "github.com"], true);

    if (existingPR(ctx.branch)) {
        return;
    }

    const base = fetchMain("origin");

    if (!gitOK("merge-base", "--is-ancestor", base, ctx.head)) {
        throw new Error("Update this branch to include origin/main before publishing.");
    }

    if (base === ctx.head) {
        throw new Error("This branch has no changes beyond origin/main.");
    }

    const title = prTitle(ctx, description.trim(), base);

    await confirm(
        `Publish ${ctx.branch} at ${ctx.head} and create a PR?\nRepository: ${forkRepository}\nBase: main\nTitle: ${title}\nOnly this branch will be pushed, without force.`,
    );
    unchanged(ctx);
    publicationDestination(ctx);

    if (existingPR(ctx.branch)) {
        return;
    }

    unchanged(ctx);
    publicationDestination(ctx);
    run("git", ["push", "--no-follow-tags", "origin", `${ctx.head}:refs/heads/${ctx.branch}`]);

    try {
        unchanged(ctx);
        publicationDestination(ctx);
        git("config", "--local", `branch.${ctx.branch}.remote`, "origin");
        git("config", "--local", `branch.${ctx.branch}.merge`, `refs/heads/${ctx.branch}`);

        if (!existingPR(ctx.branch, true)) {
            run("gh", [
                "pr",
                "create",
                "--repo",
                forkRepository,
                "--base",
                "main",
                "--head",
                `lingmann:${ctx.branch}`,
                "--title",
                title,
                "--body",
                description || title,
            ]);
        }
    } catch (error) {
        console.error(
            `Branch ${ctx.branch} was pushed at ${ctx.head}, but PR creation did not finish. Retry just pr with the same description; it checks for an existing PR before pushing or creating another.`,
        );

        throw error;
    }
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
        `Publish ${tag}?\nFork main: ${ctx.head}\nDestination: origin (${ctx.pushURL})\nConfirm only after main has been reviewed and tested, including required GitHub checks and manual release checks. No local tests will run. Only the new tag will be pushed; this does not deploy.`,
    );
    unchanged(ctx);
    releaseMain(ctx);
    run("git", ["tag", "-a", tag, ctx.head, "-m", `Victor ${version}\n\nFork main: ${ctx.head}`]);

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
    process.env.GIT_OPTIONAL_LOCKS = "0";

    const color = process.stdout.isTTY && !Object.hasOwn(process.env, "NO_COLOR");
    const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
    const heading = (text, code = 1) => console.log(`\n${paint(code, text)}`);
    const lines = (text) => (text ? text.split("\n") : []);
    const upstream = "refs/remotes/upstream/main";
    const history = ["refs/remotes/origin/main", "refs/heads/main"].find((name) =>
        gitOK("show-ref", "--verify", "--quiet", name),
    );
    const historyName =
        history === "refs/remotes/origin/main"
            ? "origin/main (cached fork ref)"
            : "main (origin/main unavailable)";
    let fetched = false;

    try {
        fetchMain("upstream", true);
        fetched = true;
        console.log("pi-pocket · upstream/main fetched just now");
    } catch (error) {
        console.log(paint(33, "WARNING · upstream fetch failed — showing cached refs"));
        console.log(`  ${error.message}`);
    }

    const hasUpstream = gitOK("show-ref", "--verify", "--quiet", upstream);
    const log = (...args) => lines(git("log", "--first-parent", "--format=%H", ...args));
    const isUpstream = (hash) =>
        hasUpstream && gitOK("merge-base", "--is-ancestor", hash, upstream);
    const show = (hash, source) =>
        run("git", [
            "show",
            "--no-patch",
            `--color=${color ? "always" : "never"}`,
            "--decorate=short",
            "--decorate-refs=refs/tags/*",
            `--format=  %C(dim)%h%C(reset)  %C(${source === "upstream" ? "cyan" : source === "fork" ? "magenta" : "dim"})${source.padEnd(10)}%C(reset)%s%C(yellow)%d%C(reset)`,
            hash,
        ]);

    if (history && hasUpstream) {
        const incoming = log(upstream, "--not", history);

        heading(
            `UPSTREAM AHEAD · ${incoming.length} update${incoming.length === 1 ? "" : "s"}${fetched ? " not in fork main" : " in cached upstream/main"}`,
            36,
        );
        console.log(`  upstream/main → ${historyName}`);

        if (incoming.length) {
            console.log();
        }

        for (const hash of incoming) {
            show(hash, "upstream");
        }

        if (gitOK("merge-base", history, upstream)) {
            const boundary = git("merge-base", history, upstream);
            const tag = git("tag", "--points-at", boundary);

            console.log(
                `\n  ── Already included through ${boundary.slice(0, 7)}${tag ? ` · ${lines(tag).join(", ")}` : ""} ──`,
            );
        } else {
            console.log("  No common ancestor with upstream/main.");
        }
    } else {
        heading("UPSTREAM AHEAD · unavailable", 33);
        console.log(
            `  ${!hasUpstream ? "No cached upstream/main." : "No fork-main ref available."}`,
        );
    }

    heading(`RECENT FORK HISTORY · ${history ? historyName : "unavailable"}`, 35);
    const latest = git(
        "for-each-ref",
        "--sort=-creatordate",
        "--count=1",
        "--format=%(refname:short)",
        "refs/tags/victor/",
    );

    console.log(`  Latest local fork release: ${latest || "none"}`);

    if (history) {
        console.log();
    }

    if (history && !hasUpstream) {
        console.log("  Upstream classification and imported history unavailable.\n");
    }

    const shown = new Set();

    const entry = (hash) => {
        if (shown.size < 12 && !shown.has(hash)) {
            show(hash, !hasUpstream ? "unknown" : isUpstream(hash) ? "upstream" : "fork");
            shown.add(hash);
        }
    };

    if (history) {
        for (const hash of log("-12", history)) {
            entry(hash);

            if (shown.size >= 12) {
                break;
            }

            // Expand imported upstream history beneath its fork merge, not by commit date.
            if (hasUpstream && !isUpstream(hash) && gitOK("rev-parse", "--verify", `${hash}^2`)) {
                for (const imported of log(upstream, "--not", `${hash}^1`)) {
                    if (gitOK("merge-base", "--is-ancestor", imported, hash)) {
                        entry(imported);
                    }

                    if (shown.size >= 12) {
                        break;
                    }
                }
            }
        }
    }

    const branch = git("branch", "--show-current") || "HEAD detached";

    heading(`LOCAL CHANGES · ${branch}`);

    if (
        [
            "MERGE_HEAD",
            "rebase-merge",
            "rebase-apply",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "sequencer",
            "BISECT_LOG",
        ].some((name) => existsSync(git("rev-parse", "--git-path", name)))
    ) {
        console.log("  Git operation in progress; run git status for details.");
    }

    let changed = false;

    for (const [title, args] of [
        ["Staged · git diff --cached --stat", ["--cached"]],
        ["Unstaged · git diff --stat", []],
    ]) {
        if (!gitOK("diff", ...args, "--quiet")) {
            changed = true;
            heading(title);
            run("git", ["diff", ...args, `--color=${color ? "always" : "never"}`, "--stat"]);
        }
    }

    const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];

    if (git(...untrackedArgs)) {
        changed = true;
        heading("Untracked");
        run("git", untrackedArgs);
    }

    if (!changed) {
        console.log("  Working tree clean");
    }
}

try {
    const args = process.argv.slice(2);

    if (args.some((arg) => arg.trimStart().startsWith("-"))) {
        throw new Error("Options and values starting with '-' are not supported.");
    }

    const [action, argument, ...extra] = args;
    const actions = { status, check, feature, "upstream-update": upstreamUpdate, pr, release };
    const noArguments = action === "status" || action === "check";

    if (
        !Object.hasOwn(actions, action ?? "") ||
        extra.length ||
        (argument !== undefined && noArguments) ||
        (argument === undefined && !noArguments && action !== "pr")
    ) {
        throw new Error(
            "Usage: node scripts/victor/fork.mjs status|check|feature SLUG|upstream-update NAME|pr [DESCRIPTION]|release VERSION",
        );
    }

    process.chdir(git("rev-parse", "--show-toplevel"));
    await actions[action](argument);
} catch (error) {
    console.error(`fork: ${error.message}`);
    process.exitCode = 1;
}
