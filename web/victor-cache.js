// Classic-worker helper: only immutable Victor bundles belong in this cache.
(() => {
    const VICTOR_CACHE_PREFIX = "pocket-victor-";
    const victorCaches = new Map();
    const victorBundles = new Set();
    let victorCacheSetup = Promise.resolve();

    /** Clean each bundle once; serialize openings and reuse handles after cache deletion. */
    function openVictorCache(bundle) {
        const name = VICTOR_CACHE_PREFIX + bundle;

        if (!victorCaches.has(name)) {
            const first = !victorBundles.has(name);

            victorBundles.add(name);
            const ready = victorCacheSetup
                .then(async () => {
                    if (first) {
                        try {
                            const names = await caches.keys();

                            await Promise.all(
                                names
                                    .filter(
                                        (other) =>
                                            other.startsWith(VICTOR_CACHE_PREFIX) && other !== name,
                                    )
                                    .map(async (other) => {
                                        try {
                                            await caches.delete(other);
                                        } catch {
                                            // One failed deletion must not prevent the others.
                                        }
                                    }),
                            );
                        } catch {
                            // Storage may be unavailable; still try opening the current bundle.
                        }
                    }

                    return caches.open(name);
                })
                .catch(() => {
                    victorCaches.delete(name);

                    return null;
                });

            victorCaches.set(name, ready);
            victorCacheSetup = ready;
        }

        return victorCaches.get(name);
    }

    async function victorAsset(event, bundle) {
        const request = event.request;
        const cache = await openVictorCache(bundle);

        try {
            const cached = await cache?.match(request);

            if (cached) {
                return cached;
            }
        } catch {
            // A cache read failure is a miss, not a Victor failure.
        }

        const response = await fetch(request, { cache: "no-store" });

        if (cache && response.ok && response.status !== 206 && !response.redirected) {
            event.waitUntil(
                (async () => {
                    try {
                        await cache.put(request, response.clone());
                    } catch {
                        // Quota, storage or interrupted downloads must not withhold the network response.
                    }
                })(),
            );
        }

        return response;
    }

    function handleFetch(event) {
        const url = new URL(event.request.url);
        const victor = /^\/victor-assets\/([A-Za-z0-9][A-Za-z0-9._-]*)\/.+/.exec(url.pathname);

        if (
            event.request.method === "GET" &&
            url.origin === self.location.origin &&
            !event.request.headers.has("range") &&
            victor
        ) {
            event.respondWith(victorAsset(event, victor[1]));

            return true;
        }

        return false;
    }

    self.pocketVictorCache = { handleFetch };
})();
