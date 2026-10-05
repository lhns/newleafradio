# 0005. Stream songs through a service worker

- Status: Accepted
- Date: 2026-10-04 (PRs #8, #12)

## Context
Songs were downloaded completely before playing (up to 72 MB). The sync needs seeking to arbitrary positions.

## Decision
- `sw.js` is a generic service worker with path routes; `ipfs/` is answered by `handleIpfsRequest` (`ipfs.js`) with verified-fetch, including Range requests. `<audio src="ipfs/<cid>/<path>">` streams and seeks like a static file.
- The page loads the same files. Without a controlling service worker (first visit, hard reload, private window), `getServiceWorkerUrl` runs the same handler in the page and plays a blob of the whole file.
- verified-fetch is loaded with `importScripts` in the worker and lazily in the page.

## Consequences
- One code path for both cases; the fallback is slower but works everywhere.
- Content type is set from the file extension, since verified-fetch only detects it for ranges starting at 0.

## Rejected
- MediaSource Extensions: not on iPhones, would need fragmented MP4.
- Decoding into an `AudioBuffer`: a 30 min song needs ~635 MB of PCM.
- Public gateways: retired (0003).
