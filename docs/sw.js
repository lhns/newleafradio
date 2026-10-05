// Service worker that answers requests for some paths with handlers instead of the network,
// e.g. to stream files from IPFS so they can be played before they are fully downloaded.
// The page loads this file as well: if no service worker controls the page,
// getServiceWorkerUrl runs the same handlers in the page instead.
const IS_SERVICE_WORKER = typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope;

// The service worker's console is hard to find, so its log messages are also shown in the pages' consoles.
const FORWARDED_LOG_LEVELS = ["debug", "info", "warn", "error"];

if (IS_SERVICE_WORKER) {
    for (const level of FORWARDED_LOG_LEVELS) {
        const log = console[level].bind(console);
        console[level] = (...args) => {
            log(...args);
            forwardLog(level, args);
        };
    }
    self.addEventListener("error", event => console.error("Uncaught error", event.error ?? event.message));
    self.addEventListener("unhandledrejection", event => console.error("Unhandled rejection", event.reason));

    importScripts("ipfs.js");
} else {
    navigator.serviceWorker?.addEventListener("message", event => {
        const {level, message} = event.data?.serviceWorkerLog ?? {};
        if (FORWARDED_LOG_LEVELS.includes(level)) console[level]("[service worker]", message);
    });
}

function forwardLog(level, args) {
    const message = args.map(arg => arg instanceof Error ? (arg.stack?.includes(arg.message) ? arg.stack : `${arg.name}: ${arg.message}
${arg.stack ?? ""}`) : String(arg)).join(" ");
    self.clients.matchAll().then(clients => {
        for (const client of clients) client.postMessage({serviceWorkerLog: {level, message}});
    }).catch(() => {
    });
}

// path prefix relative to the service worker scope -> handler(request, path after the prefix)
const SERVICE_WORKER_ROUTES = {
    "ipfs/": handleIpfsRequest
};

const SERVICE_WORKER_SCRIPT = IS_SERVICE_WORKER ? self.location.href : document.currentScript.src;
const SERVICE_WORKER_SCOPE = IS_SERVICE_WORKER ? self.registration.scope : new URL("./", SERVICE_WORKER_SCRIPT).href;

// returns a promise of the response, or null if no route matches the request
function handleServiceWorkerRequest(request) {
    const url = new URL(request.url);
    for (const [prefix, handler] of Object.entries(SERVICE_WORKER_ROUTES)) {
        const routeUrl = new URL(prefix, SERVICE_WORKER_SCOPE);
        if (url.origin === routeUrl.origin && url.pathname.startsWith(routeUrl.pathname)) {
            return handler(request, decodeURI(url.pathname.slice(routeUrl.pathname.length)));
        }
    }
    return null;
}

if (IS_SERVICE_WORKER) {
    self.addEventListener("install", () => {
        self.skipWaiting();
    });

    self.addEventListener("activate", event => {
        event.waitUntil(self.clients.claim());
    });

    self.addEventListener("fetch", event => {
        const response = handleServiceWorkerRequest(event.request);
        if (response) event.respondWith(response);
    });
}

function registerServiceWorker() {
    navigator.serviceWorker?.register(SERVICE_WORKER_SCRIPT).catch(error => {
        console.error("Service worker registration failed", error);
    });
}

// Returns a URL for the resource that can be used e.g. as a media src.
// If the service worker controls the page, the URL itself is returned and the service worker streams it.
// Otherwise the page handles the request itself, downloads the whole response and returns a blob URL,
// which is revoked when the signal aborts.
async function getServiceWorkerUrl(url, {allowServiceWorker = true, signal, onProgress} = {}) {
    if (allowServiceWorker && navigator.serviceWorker?.controller) {
        return url;
    }

    const request = new Request(url, {signal});
    const response = await (handleServiceWorkerRequest(request) ?? fetch(request));
    if (!response.ok) {
        response.body?.cancel().catch(() => {
        });
        throw new Error(`Error loading ${url}: ${response.status} ${response.statusText}`);
    }

    const totalBytes = Number(response.headers.get("content-length"));
    const reader = response.body.getReader();
    const chunks = [];
    let bytesRead = 0;
    while (true) {
        const {done, value} = await reader.read();
        signal?.throwIfAborted();
        if (done) break;
        chunks.push(value);
        bytesRead += value.length;
        if (totalBytes && onProgress) onProgress(bytesRead / totalBytes);
    }

    const blobUrl = URL.createObjectURL(new Blob(chunks, {type: response.headers.get("content-type") || ""}));
    if (signal) {
        signal.addEventListener("abort", () => URL.revokeObjectURL(blobUrl), {once: true});
        if (signal.aborted) URL.revokeObjectURL(blobUrl);
    }
    return blobUrl;
}
