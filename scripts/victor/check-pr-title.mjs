#!/usr/bin/env node
// Validate PR metadata only; upstream commits and individual branch commits are not renamed.
import { readFileSync } from "node:fs";

try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const pr = event.pull_request;

    if (!pr || typeof pr.head?.ref !== "string" || typeof pr.title !== "string") {
        throw new Error("Expected a pull_request event with a head branch and title.");
    }

    const prefix = pr.head.ref.startsWith("sync/upstream-") ? "upstream:" : "fork:";
    const description = pr.title.slice(prefix.length + 1);

    if (
        !pr.title.startsWith(`${prefix} `) ||
        !description.trim() ||
        pr.title !== pr.title.trim() ||
        /[\r\n\x00-\x1f\x7f]/.test(pr.title)
    ) {
        throw new Error(`PR title must be a single line: ${prefix} <description>`);
    }

    console.log(`PR title follows the ${prefix} convention.`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
