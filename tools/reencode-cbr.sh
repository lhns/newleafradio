#!/usr/bin/env bash
# Re-encodes variable bitrate (VBR) mp3 songs as constant bitrate (CBR) mp3.
# Browsers can't seek exactly in streamed VBR mp3 files: playback ends up to ~0.6 s away from the reported position,
# which breaks the synchronization between devices. CBR files seek within one frame.
#
# Usage: tools/reencode-cbr.sh <songs dir> <output dir> [bitrate, default 256k]
#
#   ipfs get <current CID> -o songs
#   tools/reencode-cbr.sh songs songs-cbr
#   ipfs add -r --cid-version 1 songs-cbr
#
# Then put the new root CID into IPFS_CID in docs/radio.js (and pin it wherever the old one is pinned).
# Files that aren't VBR mp3 are copied unchanged, so their blocks and CIDs stay the same.
set -euo pipefail

if [ $# -lt 2 ]; then
    echo "Usage: $0 <songs dir> <output dir> [bitrate, default 256k]" >&2
    exit 1
fi
in=$1
out=$2
bitrate=${3:-256k}

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
    tmp="$file.cbr.mp3"
    ffmpeg -nostdin -loglevel error -i "$file" -map 0:a -map_metadata 0 -c:a libmp3lame -b:a "$bitrate" "$tmp"
    before=$(duration "$file")
    after=$(duration "$tmp")
    mv "$tmp" "$file"
    converted=$((converted + 1))
    echo "$file: ${before}s -> ${after}s"
done < <(find "$out" -type f -name '*.mp3' -print0 | sort -z)

echo "Converted $converted VBR file(s) to $bitrate CBR in $out"
