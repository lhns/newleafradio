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
// fails a download that didn't receive its response or data for this long. Requests for a block join a pending
// request for the same block, so a stuck block request would also stall every retry, which is why verifiedFetch
// is replaced.
// Shorter than the player's STALL_MS (radio.js), which would otherwise cancel the download first.
const IPFS_STUCK_MS = 15 * 1000;
// A cancelled response keeps loading blocks until the end of its range (only aborting would stop it, which breaks
// verifiedFetch). Players cancel their requests all the time, e.g. when seeking, and that background loading
// delayed the next request by seconds. So open ended ranges are limited, players request the rest when needed.
const IPFS_MAX_RANGE_BYTES = 2 * 1024 * 1024;
// blocks loaded in parallel for one response, unlimited by default
const IPFS_BLOCK_READ_CONCURRENCY = 4;

// file sizes by cidPath, to limit open ended ranges to the end of the file (verified-fetch rejects ranges beyond it)
const ipfsFileSizes = new Map();

// Rejects if the response doesn't arrive within IPFS_STUCK_MS, e.g. because resolving the path got stuck on a block.
// The response may still arrive later, then its body is cancelled.
function failWhenStuck(responsePromise, name) {
    return new Promise((resolve, reject) => {
        let stuck = false;
        const timer = setTimeout(() => {
            stuck = true;
            const error = new Error(`IPFS: no response for ${IPFS_STUCK_MS / 1000} s while loading ${name}, giving up`);
            console.error(error.message);
            reject(error);
        }, IPFS_STUCK_MS);
        responsePromise.then(response => {
            clearTimeout(timer);
            if (!stuck) return resolve(response);
            response.body?.cancel().catch(() => {
            });
        }, error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

// Fetches ipfs://<cidPath>, optionally only a byte range ("bytes=start-end").
// Aborting the signal cancels the download.
async function fetchIpfs(cidPath, {range, signal} = {}) {
    const openRangeStart = range?.match(/^bytes=(\d+)-$/)?.[1];
    if (openRangeStart !== undefined) {
        const size = ipfsFileSizes.get(cidPath) ?? Infinity;
        const end = Math.min(Number(openRangeStart) + IPFS_MAX_RANGE_BYTES, size) - 1;
        if (end >= Number(openRangeStart)) range = `bytes=${openRangeStart}-${end}`;
    }
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
        // and all following requests hang. Cancelling the response body instead stops reading it.
        const request = range => failWhenStuck(verifiedFetch(`ipfs://${cidPath}`, {
            headers: range ? {range} : {},
            blockReadConcurrency: IPFS_BLOCK_READ_CONCURRENCY
        }), name);
        response = await request(range);
        // the limited range ended behind the end of the file, whose size wasn't known yet
        if (response.status === 416 && openRangeStart !== undefined) {
            response.body?.cancel().catch(() => {
            });
            range = `bytes=${openRangeStart}-`;
            response = await request(range);
        }
    } catch (error) {
        if (!signal?.aborted) resetVerifiedFetch(verifiedFetchP);
        throw error;
    }
    const size = Number(response.headers.get("content-range")?.split("/")[1]);
    if (size) ipfsFileSizes.set(cidPath, size);

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
        // when the pending read started, null while nothing is requested (e.g. the player has buffered enough)
        let readStart = null;
        let lastWarning = 0;
        let streamController;
        const slowTimer = setInterval(() => {
            if (readStart === null) return;
            const idle = Date.now() - readStart;
            if (idle > IPFS_STUCK_MS) {
                const error = new Error(`IPFS: no data for ${(idle / 1000).toFixed(0)} s while loading ${name} (${bytes} bytes so far), giving up`);
                if (!finish("stuck")) return;
                console.error(error.message);
                resetVerifiedFetch(verifiedFetchP);
                reader.cancel(error).catch(() => {
                });
                streamController.error(error);
            } else if (idle > IPFS_SLOW_MS && Date.now() - lastWarning > IPFS_SLOW_MS) {
                console.warn(`IPFS: no data for ${(idle / 1000).toFixed(0)} s while loading ${name} (${bytes} bytes so far)`);
                lastWarning = Date.now();
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
            start(controller) {
                streamController = controller;
            },
            async pull(controller) {
                try {
                    readStart = Date.now();
                    const {done, value} = await reader.read();
                    readStart = null;
                    // the stream was cancelled while reading
                    if (finished) return;
                    if (done) {
                        finish("finished");
                        controller.close();
                    } else {
                        bytes += value.length;
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
