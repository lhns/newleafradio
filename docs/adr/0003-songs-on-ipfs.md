# 0003. Host the songs on IPFS

- Status: Accepted
- Date: 2024-07-31, CIDv1 since 2024-12-09

## Context
The songs are ~2.4 GB and shouldn't live in the GitHub repo or on Pages.

## Decision
- All songs are in one IPFS directory, addressed by a CIDv1 root (`IPFS_CID` in `radio.js`): `<Weather><Game>/<hour><AM|PM>.m4a`.
- Content is fetched and verified in the browser with `@helia/verified-fetch`.
- The maintainer's Kubo node (`ipfs.lhns.de`, AutoTLS `wss`, WebTransport, WebRTC) provides the content; Pinata holds parts of it.

## Consequences
- Changing a file changes the root CID: re-add the folder, pin the new CID, update `IPFS_CID` and the README together (see 0015).
- Availability depends on the providers; unchanged folders keep their CIDs and blocks.
- Public path gateways (ipfs.io, dweb.link) no longer serve content, so they are not an option (verified 2026-10).
