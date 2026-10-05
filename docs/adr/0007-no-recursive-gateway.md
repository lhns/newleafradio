# 0007. Fetch from providers directly, without a recursive gateway

- Status: Accepted
- Date: 2026-10-05 (PR #9)

## Context
verified-fetch used `trustless-gateway.link` as recursive gateway by default. Once it served the first block, the session asked only it for later blocks and looked for other providers only after it failed, which took a 60 s Cloudflare timeout (522). The maintainer's node was found and connected, but unused. (2024-08 experiments with custom and default gateways showed similar problems.)

## Decision
`createVerifiedFetch({gateways: []})`: providers come from delegated routing (`delegated-ipfs.dev`) and are fetched from directly — the node over `wss`/WebTransport/WebRTC, HTTP gateways that routing lists as providers (Pinata).

## Consequences
- No hard-wired gateway; songs load in seconds when the node is up.
- Networks that block port 4001 can't reach the node; the root folder is then only available if someone else provides it. Pinning the root on an HTTPS provider would cover that.
