import { join } from 'node:path';
import { app } from 'electron';
import { binPath } from '../paths';

/**
 * yt-dlp lives in two possible places at runtime:
 *
 *   1. `<userData>/binaries/yt-dlp` — written by the auto-updater
 *      after a successful download. Outside the signed `.app`
 *      bundle so macOS doesn't reject the modification.
 *   2. `<resourcesPath>/binaries/yt-dlp` (packaged) or
 *      `<repo>/resources/binaries/yt-dlp` (dev) — the version
 *      baked in at build time by `scripts/fetch-binaries.sh`.
 *
 * `getYtDlpPath()` prefers (1) when present, falls back to (2).
 * This is the path the queue + transcription pipeline use; ffmpeg
 * stays on the original `binPath()` since we don't auto-update it.
 */

/** Where the auto-updater writes a freshly-downloaded yt-dlp.
 * Returns the path even when the file doesn't exist yet, so callers
 * can `fs.access` it cheaply to decide which binary is in use. */
export const getUserDataYtDlpPath = (): string => {
  return join(app.getPath('userData'), 'binaries', 'yt-dlp');
};

/** Where the bundled (build-time) yt-dlp lives. */
export const getBundledYtDlpPath = (): string => {
  return binPath('yt-dlp');
};
