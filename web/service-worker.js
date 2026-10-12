// Shared service-worker registration for shares, Victor caching, and notifications.
const workerSupported = "serviceWorker" in navigator;

let registering = null;

/** Register victor caching and shares even without push. Workers need HTTPS or localhost. */
export function registerWorker() {
    if (!workerSupported || !isSecureContext) {
        return Promise.resolve(null);
    }

    try {
        registering ??= navigator.serviceWorker.register("/sw.js").catch(() => null);
    } catch {
        registering = Promise.resolve(null);
    }

    return registering;
}

/** Null when no wait is needed; otherwise give first installation up to 1.5 seconds to claim this page. */
export function waitForWorkerControl() {
    if (!workerSupported || !isSecureContext || navigator.serviceWorker.controller) {
        return null;
    }

    const serviceWorker = navigator.serviceWorker;

    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timeout);
            serviceWorker.removeEventListener("controllerchange", controlled);
            resolve();
        };

        const controlled = () => {
            if (serviceWorker.controller) {
                finish();
            }
        };

        const timeout = setTimeout(finish, 1500);

        serviceWorker.addEventListener("controllerchange", controlled);
        void registerWorker().then((registration) => {
            if (registration) {
                controlled();
            } else {
                finish();
            }
        }, finish);
        controlled();
    });
}
