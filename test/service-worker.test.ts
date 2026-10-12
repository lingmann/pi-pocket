// Registration and first-activation control waits without a browser or notification permission.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { runInNewContext } from "node:vm";

const source = (await readFile(new URL("../web/service-worker.js", import.meta.url), "utf8"))
    .replace(/^import .*?;\n/gm, "")
    .replace(/^export /gm, "");

type Notify = {
    registerWorker(): Promise<unknown>;
    waitForWorkerControl(): Promise<void> | null;
};

class ServiceWorker extends EventTarget {
    controller: object | null = null;
    registrations: string[] = [];
    listeners = new Set<EventListenerOrEventListenerObject>();
    registration = Promise.withResolvers<unknown>();
    failure: "reject" | "throw" | undefined;

    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        assert.equal(type, "controllerchange");
        this.listeners.add(listener);
        super.addEventListener(type, listener);
    }

    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.listeners.delete(listener);
        super.removeEventListener(type, listener);
    }

    register(path: string) {
        this.registrations.push(path);

        if (this.failure === "throw") {
            throw new Error("registration blocked");
        }

        return this.failure === "reject"
            ? Promise.reject(new Error("registration failed"))
            : this.registration.promise;
    }

    claim() {
        this.controller = {};
        this.dispatchEvent(new Event("controllerchange"));
    }
}

function harness(
    t: TestContext,
    options: {
        supported?: boolean;
        secure?: boolean;
        notifications?: boolean;
        failure?: "reject" | "throw";
        permission?: string;
    } = {},
) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const serviceWorker = new ServiceWorker();
    const context = {
        navigator: options.supported === false ? {} : { serviceWorker },
        isSecureContext: options.secure !== false,
        setTimeout,
        clearTimeout,
        ...(options.notifications
            ? { PushManager: {}, Notification: { permission: options.permission ?? "granted" } }
            : {}),
        tested: undefined as Notify | undefined,
    };

    serviceWorker.failure = options.failure;
    runInNewContext(
        `${source}\nglobalThis.tested = { registerWorker, waitForWorkerControl };`,
        context,
        { filename: "web/service-worker.js" },
    );
    t.after(() => {
        t.mock.timers.runAll();
        assert.equal(serviceWorker.listeners.size, 0, "control waits release their listeners");
    });

    return { api: context.tested!, serviceWorker };
}

test("secure browsers register once without notification APIs or permission", async (t) => {
    for (const notifications of [false, true]) {
        await t.test(
            notifications ? "notifications denied" : "notifications unavailable",
            async (t) => {
                const { api, serviceWorker } = harness(t, { notifications, permission: "denied" });
                const first = api.registerWorker();
                const second = api.registerWorker();

                assert.equal(first, second);
                assert.deepEqual(serviceWorker.registrations, ["/sw.js"]);
                serviceWorker.registration.resolve({});
                assert.ok(await first);
            },
        );
    }
});

test("unsupported or insecure pages do not register or wait", async (t) => {
    for (const options of [{ supported: false }, { secure: false }]) {
        await t.test(JSON.stringify(options), async (t) => {
            const { api, serviceWorker } = harness(t, options);

            assert.equal(await api.registerWorker(), null);
            assert.equal(api.waitForWorkerControl(), null);
            assert.deepEqual(serviceWorker.registrations, []);
        });
    }
});

test("an already controlled page needs no victor startup wait", (t) => {
    const { api, serviceWorker } = harness(t);

    serviceWorker.claim();
    assert.equal(api.waitForWorkerControl(), null);
    assert.equal(serviceWorker.listeners.size, 0);
});

test("first installation waits for control, not just registration", async (t) => {
    const { api, serviceWorker } = harness(t);
    let done = false;
    const waiting = api.waitForWorkerControl()!.then(() => {
        done = true;
    });

    assert.deepEqual(serviceWorker.registrations, ["/sw.js"]);
    assert.equal(serviceWorker.listeners.size, 1);
    serviceWorker.registration.resolve({});
    await settle();
    assert.equal(done, false);
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    await settle();
    assert.equal(done, false, "an event without a controller is not readiness");
    serviceWorker.claim();
    await waiting;
    assert.equal(done, true);
    assert.equal(serviceWorker.listeners.size, 0);
    t.mock.timers.tick(1500);
});

test("control can arrive while registration is still pending", async (t) => {
    const { api, serviceWorker } = harness(t);
    const waiting = api.waitForWorkerControl();

    serviceWorker.claim();
    await waiting;
    assert.equal(serviceWorker.listeners.size, 0);
    serviceWorker.registration.resolve({});
    await settle();
});

test("a stalled registration or claim waits at most 1.5 seconds", async (t) => {
    for (const stalled of ["registration", "claim"]) {
        await t.test(stalled, async (t) => {
            const { api, serviceWorker } = harness(t);
            let done = false;
            const waiting = api.waitForWorkerControl()!.then(() => {
                done = true;
            });

            if (stalled === "claim") {
                serviceWorker.registration.resolve({});
            }

            t.mock.timers.tick(1499);
            await settle();
            assert.equal(done, false);
            t.mock.timers.tick(1);
            await waiting;
            assert.equal(done, true);
            assert.equal(serviceWorker.listeners.size, 0);
            serviceWorker.registration.resolve({});
            await settle();
        });
    }
});

test("registration rejection and synchronous failure resolve the wait without blocking Victor", async (t) => {
    for (const failure of ["reject", "throw"] as const) {
        await t.test(failure, async (t) => {
            const { api, serviceWorker } = harness(t, { failure });

            await api.waitForWorkerControl();
            assert.equal(await api.registerWorker(), null);
            assert.deepEqual(serviceWorker.registrations, ["/sw.js"]);
            assert.equal(serviceWorker.listeners.size, 0);
        });
    }
});
