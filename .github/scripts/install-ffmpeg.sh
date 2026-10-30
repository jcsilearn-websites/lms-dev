#!/usr/bin/env bash
# Installs the pinned ffmpeg / ffprobe for DEVELOPMENT and CI (the local video provider and its tests).
# ffmpeg is never shipped in a production image: production uses a managed video provider (docs/adr/0015-video.md).
#
# The build is the BtbN month-end snapshot 2026-09-30 (GitHub keeps month-end snapshots; daily ones are removed
# after a few weeks): FFmpeg n8.1.3-9-g29e619e767, GPL build with libx264. The archive is verified against a
# SHA-256 pinned here BEFORE anything is unpacked. Same build as the one installed on the developer machine.
#
# Usage: bash .github/scripts/install-ffmpeg.sh [target dir]      (CI: the directory is added to GITHUB_PATH)
set -euo pipefail

TAG="autobuild-2026-09-30-13-08"
NAME="ffmpeg-n8.1.3-9-g29e619e767-linux64-gpl-8.1"
SHA256="97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79"
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/${TAG}/${NAME}.tar.xz"

DEST="${1:-${RUNNER_TEMP:-/tmp}/ffmpeg-bin}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$DEST"
curl -sSfL --retry 3 -o "$WORK/ffmpeg.tar.xz" "$URL"
echo "${SHA256}  $WORK/ffmpeg.tar.xz" | sha256sum -c -
tar -xJf "$WORK/ffmpeg.tar.xz" -C "$WORK" --strip-components=2 "${NAME}/bin/ffmpeg" "${NAME}/bin/ffprobe"
install -m 0755 "$WORK/ffmpeg" "$WORK/ffprobe" "$DEST/"

if [ -n "${GITHUB_PATH:-}" ]; then echo "$DEST" >> "$GITHUB_PATH"; fi
"$DEST/ffmpeg" -version | head -1
"$DEST/ffprobe" -version | head -1
