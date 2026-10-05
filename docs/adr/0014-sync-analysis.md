# 0014. How the sync analysis finds the devices

- Status: Accepted
- Date: 2026-10-05 (PRs #10, #14, #19, #21)

## Context
The analysis must stay exact in real rooms (reverb, noise, phone speakers) and must never shift by a wrong amount; a rejection is acceptable.

## Decision
- Reference: only ~25 s around the current position, decoded at the analysis rate (~16 kHz). For mp3 in MP4 the byte range around the position is cut out of `mdat` and aligned to a verified frame header (Firefox only decodes data that starts at a frame); AAC files are decoded whole (up to 30 MB).
- Correlation: GCC-PHAT with β = 0.7, limited to 300–7000 Hz, z-scored and normalized by the loudness of the matched song part. Runs in a worker.
- This device: the strongest match close before its playback position that disappears when muted.
- Other devices: searched ±5 s around it; the earliest arrival within 40 ms that is at least 0.6× as strong counts as the direct sound (not a reflection); a score of at least 15 is required.
- Ambiguity: another match more than 0.5 s away that is at least 0.8× as strong rejects the result.

## Consequences
In simulations with measured rooms and noise down to 0 dB SNR: no wrong shifts beyond ~20 ms except near-silent passages, about a third rejected at 0 dB. Tiled rooms (direct sound much weaker than reflections) are mostly 5–20 ms late or rejected. Not yet verified on real devices.
