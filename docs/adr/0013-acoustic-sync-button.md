# 0013. Manual sync button using the music itself

- Status: Accepted
- Date: 2026-10-05 (PR #10)

## Context
Wall-clock sync (0002) leaves devices tens of ms to seconds apart (clock offsets, output latencies). A concept proposed ultrasonic pulses with firefly sync or leader election.

## Decision
A manual "Sync with nearby device" button that listens to the music:
- It records ~4 s from the microphone (echo cancellation, noise suppression and auto gain off), the last 2 s with this device muted, and cross-correlates the recording with the decoded song.
- The peak that disappears when muted is this device; the strongest remaining peak is the other device. Their distance is the offset, applied to `syncOffset` and corrected via 0017.
- Only the device being synced needs the new code; nothing is emitted.
- Several devices: keep one as anchor and press Sync on the others; it syncs to the loudest one and reports the others.

## Consequences
- Mic and processing latency cancel out (both devices are heard through the same mic); each speaker's latency is measured, not assumed.
- Alignment is at this device's position (~3 ms per metre to the other device).
- Repeating music can be ambiguous; such results are rejected (0014).

## Rejected
- Ultrasonic beacons / firefly: every device must emit, many speakers can't reproduce 19 kHz, and a beacon only tells when the pulse was scheduled, not when the `<audio>` element's music leaves the speaker (its latency isn't exposed).
- Routing playback through Web Audio to tap it: iOS/Safari risks for every listener.

## Later
Automatic peer-to-peer sync can reuse this measurement on a timer (firefly with the music as signal).
