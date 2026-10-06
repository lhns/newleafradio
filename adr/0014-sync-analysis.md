# 0014. How the sync analysis finds the devices

- Status: Accepted
- Date: 2026-10-05 (PRs #10, #14, #19, #21, #28, #29, #31, #32)

## Context
The analysis must stay exact in real rooms (reverb, noise, phone speakers) and must never shift by a wrong amount; a rejection is acceptable.

## Decision
- Reference: only ~25 s around the current position, decoded at the analysis rate (~16 kHz). For mp3 in MP4 the frames around the position are cut out of `mdat` using the sample tables in `moov` (`stsz`, `stsc`, `stco`/`co64`), which also give the exact song time of each frame (`stts`, `mdhd`, minus the edit list's media time, like `currentTime`). Estimating the time from the byte offset was off by up to ~1 s, because the New Horizons songs are VBR. Chrome and Firefox decode such a cut without any offset (< 0.1 ms). AAC files are decoded whole (up to 30 MB).
- Correlation: GCC-PHAT with β = 0.7, limited to 300–7000 Hz, z-scored and normalized by the loudness of the matched song part. Runs in a worker. The recording is correlated whole, and its unmuted and muted slices (0018) each with the rest zeroed, so all three share one time base. Each slice is first scaled to the same loudness, because the microphone is ducked while this device plays. Only the reference part where devices are looked for is correlated (~1 s per measurement).
- This device: its latency is tried for the 3 strongest matches from 0.7 s before to 0.05 s after its playback position. For each, the slices are shifted by it and this device is the strongest match within 40 ms that scores at least 18 unmuted and at most 0.15× that muted. The other devices' strength differs between the unmuted and muted slices by up to ~4× (different music), so a stricter ratio is needed than "disappears":
  - close to a device heard while muted (within 40 ms) the match could be its reflection: it must be stronger than that device unmuted, and the ratio is scaled by that device's muted/unmuted ratio;
  - a stronger match elsewhere in the window that is heard while muted but stronger unmuted is this device in sync with another one; the result is rejected ("they may already be in sync"), the weaker match is a repetition of the music.
  - a match within 2.5 ms of a stronger one is its side lobe, also when the stronger one is just outside the 40 ms.
- This device is subtracted before the other devices are looked for (echo cancellation with the reference as the played signal), so it no longer dilutes their scores or matches at repetitions of the music:
  - its response from 5 ms before to 50 ms after its direct sound (881 taps) is fitted by least squares on the unmuted slices, and the same response on the muted slices; their difference is subtracted from the unmuted slices. Devices within the response's span are heard in both and cancel, so they stay in the recording;
  - fitted before the slices are scaled, so ducking is the same in all unmuted slices; short ducking bursts are followed by a gain fitted in 50 ms blocks;
  - fitted in the correlation's band and weighted by frequency (like a first difference), because music is mostly low frequencies while the correlation weighs all of them; ridge regularization (10⁻³ of the average power), solved by 40 conjugate gradient iterations (the strong components converge first; ~0.1 s per fit instead of ~0.3 s for an exact solution);
  - what is left of this device mostly scores 0–15 instead of 40–60.
- Other devices: the strongest matches of the whole recording without this device within ±5 s, that score at least 8 in the muted slices and 5 in the unmuted slices without this device; the strongest needs at least 15. The muted score rules out what is left of this device; the unmuted one rules out this device taken for the other one, when another device was taken for this one at a latency that inverts the slices. At this device's own match, a device in sync must score at least 15 while muted (this device leaks into the muted slices up to 0.15×). Not finding one is reported as "No other device heard (or it is in sync with this one)".
- Direct sound: the earliest arrival within 40 ms that is at least 0.6× as strong counts (not a reflection), among arrivals of the same kind: gone while muted for this device (so another device 2.5–40 ms ahead isn't taken for it), heard while muted for the others.
- Ambiguity: another match more than 0.5 s away that is at least 0.8× as strong rejects the result.

## Consequences
In simulations with measured rooms and noise down to 0 dB SNR: no wrong shifts beyond ~20 ms except near-silent passages, about a third rejected at 0 dB. Tiled rooms (direct sound much weaker than reflections) are mostly 5–20 ms late or rejected. With the slices (PR #31) see 0018 for the comparison.

Subtracting this device (PR #32) recovers most of the quieter other devices that the slices lost, and halves the wrong shifts (numbers in 0018). Devices in sync are still not confirmed: comparing least-squares gains of the unmuted and muted slices at the same match (normalized by the reference, so the music doesn't matter) works without ducking (this device's direct response mostly 2–2000× stronger unmuted, about 1× when it's absent, but also only 1.1–2× with an as loud other device), but with ducking and this device absent, a wrong latency inverts the slices and the ratio reaches 3–16 (42 of 360 cases would have been "in sync"). Close devices (±2 ms) can still be taken at a late reflection (20–80 ms), because what is left of this device sits at their match. ~1 s more analysis time (Node, ~3 s in all).

First real measurement (Firefox, Windows laptop, PR #29): the recording started with ~0.24 s of microphone silence and an output glitch, and this device scored only 6; recording from 0.5 s after the microphone's first sound (0013) it scores 23–25. The threshold of 18 for this device stays: with a wrong reference, a false match in its window scored 14 and disappeared when muted, so muting alone doesn't rule it out, and lowering the threshold to 15 adds 3 wrong shifts beyond 100 ms in the simulations.

Follow-up measurements on the same laptop failed with the devices within ~100 ms (PR #31): the microphone is ducked by ~8 dB, at times 30–40 dB, while this device plays, and the other device didn't disappear while muted. That led to the slices (0018).
