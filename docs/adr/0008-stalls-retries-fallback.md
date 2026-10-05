# 0008. Stall detection, retries and fallback

- Status: Accepted
- Date: 2026-10-05 (PRs #9, #13, #15, #20)

## Context
IPFS requests sometimes stall without an error. Helia joins requests for a block to a pending request for the same block, so a stuck request also stalls every retry in the same instance.

## Decision
- `ipfs.js`: a pending read or a response that doesn't arrive warns after 10 s (`IPFS_SLOW_MS`) and fails after 15 s (`IPFS_STUCK_MS`); the instance is then replaced. Time without a pending read (player buffered enough) doesn't count.
- `radio.js`: an `<audio>` that needs data but gets none for 20 s (`STALL_MS`) fails the attempt; during playback it restarts the song. The IPFS timeout is shorter so the retry gets a fresh instance.
- Each session streams twice (`STREAMING_ATTEMPTS`) before falling back to the whole-file download; retries wait 2 s.

## Consequences
- Hangs become retries instead of silence; logs say what happened (0011).
- Whole-file fallback of a 72 MB song is slow, hence the extra streaming attempt.
