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
        const promise = loadVerifiedFetchScript().then(() => HeliaVerifiedFetch.createVerifiedFetch({}));
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

// Fetches ipfs://<cidPath>, optionally only a byte range ("bytes=start-end").
// Aborting the signal cancels the download.
async function fetchIpfs(cidPath, {range, signal} = {}) {
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

    const headers = new Headers(response.headers);
    // verified-fetch only detects the content type for ranges starting at 0
    const contentType = CONTENT_TYPES[cidPath.split(".").pop().toLowerCase()];
    if (contentType && response.ok) headers.set("content-type", contentType);

    let body = response.body;
    if (body) {
        const reader = body.getReader();
        const cancel = reason => reader.cancel(reason).catch(() => {
        });
        if (signal) {
            signal.addEventListener("abort", () => cancel(signal.reason), {once: true});
            if (signal.aborted) cancel(signal.reason);
        }
        body = new ReadableStream({
            async pull(controller) {
                try {
                    const {done, value} = await reader.read();
                    if (done) {
                        controller.close();
                    } else {
                        controller.enqueue(value);
                    }
                } catch (error) {
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
