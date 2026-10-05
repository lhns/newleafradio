# 0009. Keep verified-fetch sessions alive

- Status: Accepted
- Date: 2026-10-05 (PR #11)

## Context
verified-fetch caches one session per root CID with a 60 s TTL. The first request after that evicts the session, which aborts everything it is still loading. All songs share one root, so while a long song streamed, the next request (seek, re-request, next song) failed with a 502.

## Decision
`createVerifiedFetch(..., {sessionTTLms: 24 * 60 * 60 * 1000})`.

## Consequences
Sessions aren't evicted while in use. Their provider lists can go stale; failed providers are evicted by Helia and a stuck instance is replaced (0008).
