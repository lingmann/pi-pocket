// Notification capability remains separate from service-worker support.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = (await readFile(new URL("../web/notify.js", import.meta.url), "utf8"))
    .replace(/^import .*?;\n/gm, "")
    .replace(/^export /gm, "");

function blocker(
    options: {
        worker?: boolean;
        push?: boolean;
        notification?: boolean;
        secure?: boolean;
        permission?: string;
    } = {},
) {
    return runInNewContext(source + "\nblocker()", {
        navigator: options.worker === false ? {} : { serviceWorker: {} },
        isSecureContext: options.secure !== false,
        ...(options.push === false ? {} : { PushManager: {} }),
        ...(options.notification === false
            ? {}
            : { Notification: { permission: options.permission ?? "default" } }),
    });
}

test("notifications separately require secure context, worker, push, and Notification support", () => {
    assert.match(blocker({ secure: false }), /secure/);

    for (const options of [{ worker: false }, { push: false }, { notification: false }]) {
        assert.match(blocker(options), /cannot receive/);
    }

    assert.match(blocker({ permission: "denied" }), /blocked/);
    assert.equal(blocker(), null);
    assert.equal(blocker({ permission: "granted" }), null);
});
