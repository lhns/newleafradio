// Serves files under <scope>/ipfs/<cid>/<path> from IPFS via verified-fetch,
// so <audio> elements can stream and seek them (Range requests) like static files.
importScripts("https://unpkg.com/@helia/verified-fetch@8.1.2/dist/index.min.js");

const IPFS_PREFIX = new URL("ipfs/", self.registration.scope).pathname;

const CONTENT_TYPES = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4"
};

let verifiedFetchPromise = null;

function getVerifiedFetch() {
    if (!verifiedFetchPromise) {
        const promise = HeliaVerifiedFetch.createVerifiedFetch({});
        promise.catch(() => {
            if (verifiedFetchPromise === promise) verifiedFetchPromise = null;
        });
        verifiedFetchPromise = promise;
    }
    return verifiedFetchPromise;
}

// replaces the instance after an unexpected error, in case it got into a broken state
async function resetVerifiedFetch(broken) {
    if (verifiedFetchPromise !== broken) return;
    verifiedFetchPromise = null;
    try {
        await (await broken).stop();
    } catch (error) {
        console.error(error);
    }
}

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(IPFS_PREFIX)) return;
    event.respondWith(fetchIpfs(event.request, url.pathname.slice(IPFS_PREFIX.length)));
});

async function fetchIpfs(request, path) {
    const verifiedFetchP = getVerifiedFetch();
    try {
        const verifiedFetch = await verifiedFetchP;
        const headers = {};
        const range = request.headers.get("range");
        if (range) headers.range = range;

        // No abort signal is passed on purpose: an aborted request breaks the verifiedFetch instance
        // and all following requests hang. Cancelling the response body instead stops the download,
        // because the body is only fetched from IPFS as it is read.
        const response = await verifiedFetch(`ipfs://${decodeURI(path)}`, {headers});

        const responseHeaders = new Headers(response.headers);
        // verified-fetch only detects the content type for ranges starting at 0
        const contentType = CONTENT_TYPES[path.split(".").pop().toLowerCase()];
        if (contentType) responseHeaders.set("content-type", contentType);

        let body = response.body;
        if (body) {
            const reader = body.getReader();
            const cancel = reason => reader.cancel(reason).catch(() => {
            });
            request.signal.addEventListener("abort", () => cancel(request.signal.reason), {once: true});
            if (request.signal.aborted) cancel(request.signal.reason);
            body = new ReadableStream({
                async pull(streamController) {
                    try {
                        const {done, value} = await reader.read();
                        if (done) {
                            streamController.close();
                        } else {
                            streamController.enqueue(value);
                        }
                    } catch (error) {
                        streamController.error(error);
                    }
                },
                cancel
            });
        }

        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });
    } catch (error) {
        console.error(`Error loading ${path} from IPFS`, error);
        resetVerifiedFetch(verifiedFetchP);
        return new Response(String(error), {status: 502});
    }
}
