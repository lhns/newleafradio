#!/usr/bin/env bash
# Makes variable bitrate (VBR) mp3 songs seekable exactly.
# Browsers can't seek exactly in streamed VBR mp3 files: playback ends up to ~0.6 s away from the reported position,
# which breaks the synchronization between devices.
#
# By default the mp3 frames are repackaged without re-encoding into an MP4 container (.m4a), which has exact
# timestamps for every frame, so there is no quality loss. With --cbr they are re-encoded as constant bitrate mp3
# instead, which seeks within one frame in every browser but is a lossy transcode.
#
# Usage: tools/fix-vbr-mp3.sh [--cbr [bitrate, default 320k]] <songs dir> <output dir>
#
#   ipfs get <current CID> -o songs
#   tools/fix-vbr-mp3.sh songs songs-fixed
#   ipfs add -r --cid-version 1 songs-fixed
#
# Then put the new root CID into IPFS_CID in docs/radio.js (and pin it wherever the old one is pinned).
# Files that aren't VBR mp3 are copied unchanged, so their blocks and CIDs stay the same.
set -euo pipefail

cbr=""
if [ "${1:-}" = "--cbr" ]; then
    shift
    cbr=320k
    if [[ "${1:-}" =~ ^[0-9]+k$ ]]; then
        cbr=$1
        shift
    fi
fi
if [ $# -ne 2 ]; then
    echo "Usage: $0 [--cbr [bitrate, default 320k]] <songs dir> <output dir>" >&2
    exit 1
fi
in=$1
out=$2

if [ -e "$out" ]; then
    echo "$out already exists" >&2
    exit 1
fi
cp -r "$in" "$out"

duration() {
    ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$1"
}

# the first frame of a VBR mp3 contains a "Xing" header, a CBR mp3 an "Info" header
is_vbr() {
    head -c 8192 "$1" | LC_ALL=C grep -qa Xing
}

converted=0
while IFS= read -r -d '' file; do
    if ! is_vbr "$file"; then
        continue
    fi
    before=$(duration "$file")
    if [ -n "$cbr" ]; then
        result="$file"
        ffmpeg -nostdin -loglevel error -i "$file" -map 0:a -map_metadata 0 -c:a libmp3lame -b:a "$cbr" "$file.tmp.mp3"
        mv "$file.tmp.mp3" "$result"
    else
        result="${file%.mp3}.m4a"
        # moov at the start, so browsers can stream it
        ffmpeg -nostdin -loglevel error -i "$file" -map 0:a -map_metadata 0 -c:a copy -movflags +faststart -f mp4 "$result"
        rm "$file"
    fi
    converted=$((converted + 1))
    echo "$result: ${before}s -> $(duration "$result")s"
done < <(find "$out" -type f -name '*.mp3' -print0 | sort -z)

echo "Converted $converted VBR mp3 file(s) $([ -n "$cbr" ] && echo "to $cbr CBR mp3" || echo "to .m4a without re-encoding") in $out"
