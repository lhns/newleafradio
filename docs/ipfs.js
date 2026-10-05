// Fetches files from IPFS with verified-fetch, which verifies the content against its CID.
// Works in pages and in service workers.
const VERIFIED_FETCH_URL = "https://unpkg.com/@helia/verified-fetch@8.1.2/dist/index.min.js";

// workers load the library right away, pages when it is first needed
if (typeof importScripts === "function") {
    importScripts(VERIFIED_FETCH_URL);
}

const CONTENT_TYPES = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    wav: "audio/wav",
    flac: "audio/flac",
    mp4: "video/mp4",
    webm: "video/webm",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    json: "application/json",
    txt: "text/plain",
    html: "text/html"
};

let verifiedFetchScript = null;
let verifiedFetchPromise = null;

function loadVerifiedFetchScript() {
    if (typeof HeliaVerifiedFetch !== "undefined") return Promise.resolve();
    if (!verifiedFetchScript) {
        verifiedFetchScript = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = VERIFIED_FETCH_URL;
            script.onload = resolve;
            script.onerror = () => {
                script.remove();
                verifiedFetchScript = null;
                reject(new Error("Failed to load " + VERIFIED_FETCH_URL));
            };
            document.head.append(script);
        });
    }
    return verifiedFetchScript;
}

function getVerifiedFetch() {
    if (!verifiedFetchPromise) {
        // No recursive HTTP gateway: providers are found via delegated routing and fetched from directly.
        // The default gateway (trustless-gateway.link) is used for every block once it served the first one,
        // and other providers are only looked up after it fails, which can take a 60 s timeout.
        // Sessions (per root CID) expire after 60 s by default. The first request after that evicts the
        // session, which aborts everything it is still loading and makes that request fail with a 502.
        const promise = loadVerifiedFetchScript().then(() => HeliaVerifiedFetch.createVerifiedFetch({gateways: []}, {
            sessionTTLms: 24 * 60 * 60 * 1000
        }));
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

// warns if a download didn't receive data for this long
const IPFS_SLOW_MS = 10 * 1000;

// Fetches ipfs://<cidPath>, optionally only a byte range ("bytes=start-end").
// Aborting the signal cancels the download.
async function fetchIpfs(cidPath, {range, signal} = {}) {
    const name = range ? `${cidPath} (${range})` : cidPath;
    const startTime = Date.now();
    const elapsed = () => `${((Date.now() - startTime) / 1000).toFixed(1)} s`;
    console.debug(`IPFS: loading ${name}`);
    const verifiedFetchP = getVerifiedFetch();
    let response;
    try {
        const verifiedFetch = await verifiedFetchP;
        signal?.throwIfAborted();
        // No abort signal is passed on purpose: an aborted request breaks the verifiedFetch instance
        // and all following requests hang. Cancelling the response body instead stops the download,
        // because the body is only fetched from IPFS as it is read.
        response = await verifiedFetch(`ipfs://${cidPath}`, {headers: range ? {range} : {}});
    } catch (error) {
        if (!signal?.aborted) resetVerifiedFetch(verifiedFetchP);
        throw error;
    }

    console.debug(`IPFS: ${response.status} after ${elapsed()} for ${name}`);
    const headers = new Headers(response.headers);
    // verified-fetch only detects the content type for ranges starting at 0
    const contentType = CONTENT_TYPES[cidPath.split(".").pop().toLowerCase()];
    if (contentType && response.ok) headers.set("content-type", contentType);

    let body = response.body;
    if (body) {
        const reader = body.getReader();
        let bytes = 0;
        let finished = false;
        let lastData = Date.now();
        const slowTimer = setInterval(() => {
            if (Date.now() - lastData > IPFS_SLOW_MS) {
                console.warn(`IPFS: no data for ${((Date.now() - lastData) / 1000).toFixed(0)} s while loading ${name} (${bytes} bytes so far)`);
                lastData = Date.now();
            }
        }, 1000);
        const finish = message => {
            if (finished) return false;
            finished = true;
            clearInterval(slowTimer);
            console.debug(`IPFS: ${message} after ${bytes} bytes and ${elapsed()} for ${name}`);
            return true;
        };
        const cancel = reason => {
            finish("cancelled");
            return reader.cancel(reason).catch(() => {
            });
        };
        if (signal) {
            signal.addEventListener("abort", () => cancel(signal.reason), {once: true});
            if (signal.aborted) cancel(signal.reason);
        }
        body = new ReadableStream({
            async pull(controller) {
                try {
                    const {done, value} = await reader.read();
                    // the stream was cancelled while reading
                    if (finished) return;
                    if (done) {
                        finish("finished");
                        controller.close();
                    } else {
                        bytes += value.length;
                        lastData = Date.now();
                        controller.enqueue(value);
                    }
                } catch (error) {
                    if (!finish("failed")) return;
                    console.error(`IPFS: error after ${bytes} bytes while loading ${name}`, error);
                    controller.error(error);
                }
            },
            cancel
        });
    }

    return new Response(body, {status: response.status, statusText: response.statusText, headers});
}

// Answers an HTTP request for <cid>/<path> (Range requests included), e.g. in a service worker.
async function handleIpfsRequest(request, cidPath) {
    try {
        return await fetchIpfs(cidPath, {range: request.headers.get("range"), signal: request.signal});
    } catch (error) {
        if (!request.signal.aborted) console.error(`Error loading ${cidPath} from IPFS`, error);
        return new Response(String(error), {status: 502});
    }
}
