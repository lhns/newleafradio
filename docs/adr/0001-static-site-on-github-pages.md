# 0001. Static site on GitHub Pages without a build step

- Status: Accepted
- Date: 2024-07-30

## Context
The radio is a reupload of newleafradio.glitch.me. It only needs to serve a few pages and scripts.

## Decision
- Serve `docs/` with GitHub Pages under newleafradio.lhns.de (`docs/CNAME`).
- Plain HTML and classic scripts sharing the global scope, no bundler. Libraries come from CDNs, pinned to versions (jQuery, Bootstrap, `@helia/verified-fetch@8.1.2`).
- Script order in `radio.html`: `ipfs.js`, `sw.js`, `acoustic-sync.js`, `radio.js`.

## Consequences
- No server-side logic: everything (IPFS, sync, retries) runs in the browser.
- Library builds must be loadable as UMD or classic scripts, also from a service worker (`importScripts`).
- Everything in `docs/`, including these records, is published.
