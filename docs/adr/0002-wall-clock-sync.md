# 0002. Synchronize playback to the wall clock

- Status: Accepted, extended by [0013](0013-acoustic-sync-button.md) and [0017](0017-jump-only-sync.md)
- Date: 2024-07-30

## Context
Every hour has one song that loops. Listeners on different devices should hear the same part at the same time, without a server.

## Decision
The song position is derived from the clock: `position = (now + outputLatency + syncOffset) % 3600 % duration` (`songPosition` in `radio.js`). All devices compute it independently.

## Consequences
- Loops restart at fixed times after the hour (multiples of the song length), on every device at once.
- Accuracy depends on the system clocks. Phones are usually within ~0.1 s; Windows PCs can be off by seconds.
- `syncOffset` (0013) corrects a device's offset measured by ear.
