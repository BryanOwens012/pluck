#!/usr/bin/env bash
# Download yt-dlp, ffmpeg, and ffprobe into resources/binaries/.
#
# Why a script instead of committing the binaries? ffmpeg's universal-arch
# build is ~150 MB; GitHub rejects single files over 100 MB. Per-arch is fine
# but committing 35–88 MB blobs bloats every clone, and bumping versions
# becomes a noisy commit. This script keeps the repo light and the binaries
# easy to refresh.
#
# Why ffprobe alongside ffmpeg? yt-dlp's post-processing (merging streams,
# embedding metadata, embedding thumbnails) uses ffmpeg AND ffprobe. yt-dlp
# locates ffprobe by looking in the same directory as the ffmpeg binary it
# was given via --ffmpeg-location, so the two need to be co-located.
#
# Behavior:
#   - Skips a download if the destination file already exists and is non-empty
#     (use --force to refetch).
#   - By default, fetches per-host architecture only.
#   - --universal stitches arm64+x86_64 with `lipo`. Needed when building a
#     distributable DMG that runs on both Apple Silicon and Intel.
#   - yt-dlp's official macOS build is already universal, so no arch flag.

set -euo pipefail

YT_DLP_VERSION="2026.03.17"
# martin-riedl.de hosts per-build snapshots of ffmpeg + ffprobe at parallel
# URLs (one zip each, same per-arch build identifier).
FFMPEG_ARM64_BUILD="1778771734_N-124449-g8ffaead836"
FFMPEG_AMD64_BUILD="1767299902_N-122320-g38e89fe502"

YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_macos"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$REPO_ROOT/resources/binaries"
mkdir -p "$BIN_DIR"

FORCE=0
UNIVERSAL=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --universal) UNIVERSAL=1 ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

needs_download() {
  local dest="$1"
  if [ "$FORCE" -eq 1 ]; then return 0; fi
  if [ ! -s "$dest" ]; then return 0; fi
  return 1
}

# Build the per-arch URL for an ffmpeg-family binary (ffmpeg or ffprobe) on
# martin-riedl.de. The URL pattern is identical except for the binary name
# and the per-arch build identifier.
ffmpeg_family_url() {
  local arch="$1"   # arm64 | amd64
  local binary="$2" # ffmpeg | ffprobe
  local build
  if [ "$arch" = "arm64" ]; then
    build="$FFMPEG_ARM64_BUILD"
  else
    build="$FFMPEG_AMD64_BUILD"
  fi
  echo "https://ffmpeg.martin-riedl.de/download/macos/${arch}/${build}/${binary}.zip"
}

# Fetch an ffmpeg-family binary (ffmpeg or ffprobe). Same per-arch / universal
# logic as the old hand-rolled ffmpeg block, factored out so adding ffprobe
# was a one-line call instead of a 30-line copy.
fetch_ffmpeg_family() {
  local binary="$1"
  local dest="$BIN_DIR/$binary"
  if ! needs_download "$dest"; then
    echo "[fetch-binaries] ${binary} already present, skipping (use --force to refetch)"
    return
  fi

  local tmp
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # intentionally capture $tmp at trap-set time
  trap "rm -rf '$tmp'" RETURN

  if [ "$UNIVERSAL" -eq 1 ]; then
    echo "[fetch-binaries] ${binary} universal -> $dest"
    curl -fsSL -o "$tmp/arm64.zip" "$(ffmpeg_family_url arm64 "$binary")"
    curl -fsSL -o "$tmp/amd64.zip" "$(ffmpeg_family_url amd64 "$binary")"
    unzip -q "$tmp/arm64.zip" -d "$tmp/arm64"
    unzip -q "$tmp/amd64.zip" -d "$tmp/amd64"
    lipo -create "$tmp/arm64/$binary" "$tmp/amd64/$binary" -output "$dest"
  else
    local arch
    case "$(uname -m)" in
      arm64) arch="arm64" ;;
      x86_64) arch="amd64" ;;
      *)
        echo "[fetch-binaries] unsupported architecture: $(uname -m)" >&2
        exit 1
        ;;
    esac
    echo "[fetch-binaries] ${binary} ${arch} -> $dest"
    curl -fsSL -o "$tmp/${binary}.zip" "$(ffmpeg_family_url "$arch" "$binary")"
    unzip -q "$tmp/${binary}.zip" -d "$tmp"
    mv "$tmp/$binary" "$dest"
  fi
  chmod +x "$dest"
}

# yt-dlp (universal, always).
YTDLP_DEST="$BIN_DIR/yt-dlp"
if needs_download "$YTDLP_DEST"; then
  echo "[fetch-binaries] yt-dlp $YT_DLP_VERSION -> $YTDLP_DEST"
  curl -fsSL -o "$YTDLP_DEST" "$YT_DLP_URL"
  chmod +x "$YTDLP_DEST"
else
  echo "[fetch-binaries] yt-dlp already present, skipping (use --force to refetch)"
fi

fetch_ffmpeg_family ffmpeg
fetch_ffmpeg_family ffprobe

echo "[fetch-binaries] done"
