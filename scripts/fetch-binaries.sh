#!/usr/bin/env bash
# Download yt-dlp and ffmpeg into resources/binaries/.
#
# Why a script instead of committing the binaries? ffmpeg's universal-arch
# build is ~150 MB; GitHub rejects single files over 100 MB. Per-arch is fine
# but committing 35–88 MB blobs bloats every clone, and bumping versions
# becomes a noisy commit. This script keeps the repo light and the binaries
# easy to refresh.
#
# Behavior:
#   - Skips a download if the destination file already exists and is non-empty
#     (use --force to refetch).
#   - By default, fetches ffmpeg for the local architecture only.
#   - --universal stitches an arm64+x86_64 ffmpeg with `lipo`. Needed when
#     building a distributable DMG that runs on both Apple Silicon and Intel.
#   - yt-dlp's official macOS build is already universal, so no arch flag.

set -euo pipefail

YT_DLP_VERSION="2026.03.17"
FFMPEG_ARM64_BUILD="1778771734_N-124449-g8ffaead836"
FFMPEG_AMD64_BUILD="1767299902_N-122320-g38e89fe502"

YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_macos"
FFMPEG_ARM64_URL="https://ffmpeg.martin-riedl.de/download/macos/arm64/${FFMPEG_ARM64_BUILD}/ffmpeg.zip"
FFMPEG_AMD64_URL="https://ffmpeg.martin-riedl.de/download/macos/amd64/${FFMPEG_AMD64_BUILD}/ffmpeg.zip"

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

# yt-dlp (universal, always).
YTDLP_DEST="$BIN_DIR/yt-dlp"
if needs_download "$YTDLP_DEST"; then
  echo "[fetch-binaries] yt-dlp $YT_DLP_VERSION -> $YTDLP_DEST"
  curl -fsSL -o "$YTDLP_DEST" "$YT_DLP_URL"
  chmod +x "$YTDLP_DEST"
else
  echo "[fetch-binaries] yt-dlp already present, skipping (use --force to refetch)"
fi

# ffmpeg.
FFMPEG_DEST="$BIN_DIR/ffmpeg"
if needs_download "$FFMPEG_DEST"; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT

  if [ "$UNIVERSAL" -eq 1 ]; then
    echo "[fetch-binaries] ffmpeg universal -> $FFMPEG_DEST"
    curl -fsSL -o "$TMP/arm64.zip" "$FFMPEG_ARM64_URL"
    curl -fsSL -o "$TMP/amd64.zip" "$FFMPEG_AMD64_URL"
    unzip -q "$TMP/arm64.zip" -d "$TMP/arm64"
    unzip -q "$TMP/amd64.zip" -d "$TMP/amd64"
    lipo -create "$TMP/arm64/ffmpeg" "$TMP/amd64/ffmpeg" -output "$FFMPEG_DEST"
  else
    local_arch="$(uname -m)"
    if [ "$local_arch" = "arm64" ]; then
      url="$FFMPEG_ARM64_URL"
    elif [ "$local_arch" = "x86_64" ]; then
      url="$FFMPEG_AMD64_URL"
    else
      echo "[fetch-binaries] unsupported architecture: $local_arch" >&2
      exit 1
    fi
    echo "[fetch-binaries] ffmpeg $local_arch -> $FFMPEG_DEST"
    curl -fsSL -o "$TMP/ffmpeg.zip" "$url"
    unzip -q "$TMP/ffmpeg.zip" -d "$TMP"
    mv "$TMP/ffmpeg" "$FFMPEG_DEST"
  fi
  chmod +x "$FFMPEG_DEST"
else
  echo "[fetch-binaries] ffmpeg already present, skipping (use --force to refetch)"
fi

echo "[fetch-binaries] done"
