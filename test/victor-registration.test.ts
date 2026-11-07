import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = (
    await readFile(new URL("../web/service-worker.js", import.meta.url), "utf8")
).replace(/^export /gm, "");

type Registration = {
    registerWorker(): Promise<object | null>;
    waitForWorkerControl(): Promise<void> | null;
};

for (const failure of ["reject", "throw"]) {
    test(`Victor retries registration after ${failure} and shares the new attempt`, async () => {
        let calls = 0;
        const next = Promise.withResolvers<object>();
        const serviceWorker = Object.assign(new EventTarget(), {
            controller: null as object | null,
            register(path: string) {
                assert.equal(path, "/sw.js");
                calls++;

                if (calls === 1) {
                    if (failure === "throw") {
                        throw new Error("temporary registration failure");
                    }

                    return Promise.reject(new Error("temporary registration failure"));
                }

                return next.promise;
            },
        });
        const context = {
            navigator: { serviceWorker },
            isSecureContext: true,
            setTimeout,
            clearTimeout,
            tested: undefined as Registration | undefined,
        };

        runInNewContext(
            `${source}\nglobalThis.tested = { registerWorker, waitForWorkerControl };`,
            context,
        );
        const api = context.tested!;

        assert.equal(await api.registerWorker(), null);
        const first = api.registerWorker();
        const second = api.registerWorker();
        const waiting = api.waitForWorkerControl();

        assert.equal(first, second);
        assert.equal(calls, 2);
        serviceWorker.controller = {};
        serviceWorker.dispatchEvent(new Event("controllerchange"));
        next.resolve(serviceWorker.controller);
        await waiting;
        assert.equal(await first, serviceWorker.controller);
        assert.equal(await api.registerWorker(), serviceWorker.controller);
        assert.equal(calls, 2);
    });
}
