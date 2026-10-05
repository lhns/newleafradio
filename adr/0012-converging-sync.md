# 0012. Converge playback by seeking and rate changes

- Status: Superseded by [0017](0017-jump-only-sync.md)
- Date: 2026-10-05 (PR #10)

## Context
Setting `audio.currentTime` pauses playback until the new position is loaded, so every seek lands ~100 ms (or more) late. The old code seeked on every `playing` event, throttled to 10 s.

## Decision
`syncAudio` converges on `songPosition`:
- differences above 0.25 s seek (at most once per 10 s, `SYNC_SEEK_INTERVAL_MS`);
- the rest, including the time lost seeking, is made up by playing 5 % faster or slower (`SYNC_RATE_CHANGE`) until within 3 ms;
- the lag is averaged over 10 readings 10 ms apart, with the output latency read once, because `currentTime` advances in steps and `outputLatency` fluctuates.

It runs on start, after buffering and for every song, not only after the sync button.

## Consequences
Devices settle within about ±8 ms of their target. Brief tempo changes of 5 % are possible; pitch is preserved by the browser. Seeks still depend on the file format (0015).
