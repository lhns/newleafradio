# 0006. Never abort verified-fetch, cancel bodies instead

- Status: Accepted
- Date: 2026-10-04 (PRs #7, #8; confirmed in #20)

## Context
Passing an abort signal to verified-fetch breaks the instance: after one aborted request, all following requests hang or fail with `LoadBlockFailedError` (related: helia#780). Players cancel requests constantly (seeking, switching songs).

## Decision
- `fetchIpfs` never passes a signal to verified-fetch. Cancelling the response body stops the download, because blocks are only fetched as the body is read.
- One shared instance (`getVerifiedFetch`), replaced (`resetVerifiedFetch`) only after a real error or a stuck request (0008).

## Consequences
- A request can't be cancelled before its headers arrive; its result is discarded.
- A cancelled body may still finish blocks already in flight (limited by 0010).
