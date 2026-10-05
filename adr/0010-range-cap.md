# 0010. Cap open-ended ranges and read-ahead

- Status: Accepted
- Date: 2026-10-05 (PR #20)

## Context
The player first requests a song from byte 0, then cancels and seeks to the synced position. The cancelled request kept loading blocks with unlimited parallelism (0006), delaying the seek: 6 s instead of 0.9 s at 50 MB into a 72 MB song.

## Decision
- Open-ended ranges (`bytes=N-`) are answered with at most 2 MB (`IPFS_MAX_RANGE_BYTES`), clamped to the file size once known (cached per path). A 416 for a capped range is retried with the open range.
- verified-fetch reads at most 4 blocks per response in parallel (`IPFS_BLOCK_READ_CONCURRENCY`).

## Consequences
Switching to New Leaf dropped from 3.5–5.6 s to ~0.7 s (Chrome). The player requests more ranges, which it handles natively.
