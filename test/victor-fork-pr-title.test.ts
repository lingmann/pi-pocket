import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../scripts/victor/check-pr-title.mjs", import.meta.url));

function check(event: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "fork-pr-title-"));
    const path = join(dir, "event.json");

    try {
        writeFileSync(path, JSON.stringify(event));

        return spawnSync(process.execPath, [script], {
            encoding: "utf8",
            env: { ...process.env, GITHUB_EVENT_PATH: path },
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("PR title prefixes follow the head branch, not individual commit titles", () => {
    for (const [branch, title, valid] of [
        ["feature/audio", "fork: fix microphone recovery", true],
        ["sync/upstream-next", "upstream: merge upstream/main (abcdef123456)", true],
        ["feature/audio", "upstream: fix microphone recovery", false],
        ["sync/upstream-next", "fork: update upstream", false],
        ["sync/other", "fork: improve tooling", true],
        ["feature/audio", "fix microphone recovery", false],
        ["feature/audio", "fork:", false],
        ["feature/audio", "fork:   ", false],
        ["feature/audio", " fork: fix audio", false],
        ["feature/audio", "fork: fix audio\n", false],
        ["feature/audio", "fork: fix\naudio", false],
        ["feature/audio", "fork: fix\u001baudio", false],
        ["feature/audio", "fork: handle $(shell) and `quotes` safely", true],
    ] as const) {
        const result = check({ pull_request: { head: { ref: branch }, title } });

        assert.equal(result.status, valid ? 0 : 1, `${branch}: ${title}\n${result.stderr}`);
    }
});

test("missing or malformed PR metadata fails closed", () => {
    for (const event of [{}, { pull_request: {} }, { pull_request: { title: 1, head: {} } }]) {
        const result = check(event);

        assert.equal(result.status, 1);
        assert.match(result.stderr, /Expected a pull_request event/);
    }
});
