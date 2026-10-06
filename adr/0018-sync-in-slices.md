# 0018. Tell this device apart by muting it in slices

- Status: Accepted, supersedes the recording scheme of [0013](0013-acoustic-sync-button.md)
- Date: 2026-10-06 (PR #31)

## Context
0013 recorded 2 s with this device playing, then 2 s with it muted, and took the match that disappeared while muted as this device. On a real laptop (Firefox, Windows) this failed whenever the devices were within ~100 ms: in sync, the other device sits at the same position and doesn't disappear; close to it, the louder other device made this device's match weak. The two halves contain different music, so the matches' strengths can't be compared between them. The microphone is also processed despite `echoCancellation: false`: while this device plays, it is ~8 dB quieter, at times 30–40 dB.

## Decision
- After the microphone delivers sound and 0.5 s to settle, 4.5 s are recorded while this device is muted and unmuted every 0.5 s (`SYNC_SLICE_S`), starting and ending unmuted. Both groups of slices cover nearly the same music.
- The samples at which each switch was made are taken from the audio clock (`AudioContext.currentTime` against the frame the recorder worklet reports), so a busy main thread doesn't shift them.
- A switch is heard after this device's latency, which is taken from its match: the analysis tries the 3 strongest matches in this device's window (0014) as latency, and skips 0.15 s after each heard switch (`SYNC_SWITCH_GUARD_S`).
- Each slice is scaled to the same loudness (ducking); the unmuted slices, the muted slices and the whole recording are correlated separately. Details in 0014.

## Consequences
- ~4 s of choppy playback instead of 2 s of silence.
- Simulations (rooms, noises and songs as in 0014, switches heard with ±20 ms jitter; "with ducking": the microphone 8 dB lower with −30 dB bursts while this device plays), old → slices (PR #31) → slices with this device subtracted (PR #32, 0014), wrong by 20 ms or more / false device / OK:
  - the other device as loud or louder, 0–300 ms or 2.4–4.5 s apart, this device sometimes absent (1935 cases): 116 → 6 → 3 / 39 → 1 → 0 / 550 → 488 → 548; with ducking 28 → 3 → 1 / 6 → 1 → 1 / 500 → 497 → 518.
  - the other device quieter (−6 to −20 dB), 0 ms to 3 s apart (1215 cases): 8 → 13 → 5 / 0 → 2 → 0 / 819 → 479 → 596; with ducking 9 → 19 → 10 / 0 → 0 → 0 / 759 → 455 → 516.
  - of these, this device absent (360 cases): with the slices all rejected except one with ducking (a reflection of the other device taken for this one), also with this device subtracted.
- Devices in sync (within the width of a match, ~1–2 ms) can't be told apart: rejected with "they may already be in sync" or "No other device heard (or it is in sync with this one)".
- A quieter other device is still rejected more often than with the old layout: the old layout confirmed devices in sync (94 of 130 without ducking), the slices can't (see 0014), and this device isn't heard in 125 of the 1215 cases (its score below 18 in the unmuted slices).
- Up to 10 correlations per measurement instead of 2, and fitting this device's response (~3 s in Node, ~1 s of it the subtraction; the reference is cropped to the search range).
- Rapid `muted` toggling might glitch some audio outputs; untested on real devices.

## Rejected
- Subtracting the muted from the unmuted correlation: the other device's strength differs between the groups by a factor of 0.3–3 (different music in the slices), so a device that is always heard leaves a large difference.
- Slices of random length (against slices following the beat): more false matches than fixed 0.5 s slices.
- Looking for other devices in the muted slices only, or in the sum of the muted and whole scores, or among more matches: spurious matches of repeating music won more often (wrong shifts of 100 ms or more).
- Normalizing by the reference's energy under the slices only: rejected most quieter devices.
