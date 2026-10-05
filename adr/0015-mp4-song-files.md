# 0015. Songs as mp3 in MP4 instead of VBR mp3

- Status: Accepted
- Date: 2026-10-05 (PRs #16, #17, #18)

## Context
Browsers can't seek exactly in streamed VBR mp3: the New Horizons songs played up to 0.6 s away from `currentTime` after a seek, differently per browser and position. CBR mp3 (New Leaf) was within one frame (~26 ms).

## Decision
- All mp3 songs are repackaged losslessly into an MP4 container (`ffmpeg -c:a copy -movflags +faststart`, `tools/fix-vbr-mp3.sh`). Every song is `.m4a`; Wild World stays AAC.
- Changing the songs: `ipfs get` the folder, convert, rebuild the folder (unchanged folders keep their CIDs), `ipfs add -r --cid-version 1`, pin the new root on the hosting node, then update `IPFS_CID` and the README in one PR.

## Consequences
- Seeks land within ~3 ms (constant offset of one encoder delay) in Chrome; Firefox plays and seeks them. Safari is untested.
- No quality loss, files grow ~0.5 %.

## Rejected
CBR re-encoding: works everywhere, but loses quality.
