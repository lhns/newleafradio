# 0017. Correct the playback only by seeking

- Status: Accepted, supersedes [0012](0012-converging-sync.md)
- Date: 2026-10-05 (PR #26)

## Context
0012 made up small differences by playing 5 % faster or slower. On real devices the tempo and pitch changes are audible and sound bad. A short jump is preferred.

## Decision
`syncAudio` only seeks, `playbackRate` stays 1:
- differences of 30 ms or more (`SYNC_JUMP_THRESHOLD_S`) seek, smaller ones are left alone; the lag is averaged over 10 readings as before;
- a seek pauses the playback until the new position is loaded, so it lands late. The landing error is measured after the playback continues and remembered per audio element (`audio.seekDelay`); the next seek aims ahead by it. A seek that still lands 30 ms or more off is repeated once with the updated delay;
- automatic syncs seek at most once per 10 s (`SYNC_SEEK_INTERVAL_MS`), so a slow network can't keep the playback seeking; a sync within the interval waits for its turn. The sync button still seeks right away;
- `playing` events are ignored while a sync runs, its own seeks cause them;
- the playback is synced again once it is faded in, because it can still shift while it starts;
- while the sync button records, automatic syncs don't seek (`audio.syncPaused`).

## Consequences
- No tempo or pitch changes; a correction is an audible jump of at least 30 ms.
- Devices stay within 30 ms of their target, offsets below that aren't corrected (the sync button reports them as "Already in sync").
- A drift without a `playing` event is only corrected by the next sync.
