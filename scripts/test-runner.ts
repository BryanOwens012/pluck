/**
 * Smoke harness for the full download pipeline: metadata -> yt-dlp into a
 * temp folder -> atomic move into ~/Downloads/Pluck-smoke. Mirrors what the
 * IPC handler does at runtime. Stand-alone Node script — does NOT boot
 * Electron, so paths are resolved directly.
 *
 * Usage:
 *   npm run test:smoke                         # default short YouTube URL
 *   npm run test:smoke -- <url>                # custom URL
 *   npm run test:smoke -- <url> audio_mp3      # custom format
 *
 * Output: log lines for metadata, temp folder, progress (throttled), and
 * the final destination path.
 *
 * This is intentionally not a Vitest test because it (a) hits the network,
 * (b) writes to ~/Downloads/Pluck-smoke/, and (c) takes several seconds.
 * The parser- and staging-level unit tests cover the deterministic edge cases.
 */

import { mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fetchMetadata, runDownload } from '../src/main/ytdlp/runner';
import { YtDlpError, YtDlpPasswordRequiredError } from '../src/main/ytdlp/types';
import type { Format } from '../src/shared/types';
import {
  createTempFolder,
  moveFile,
  removeTempFolder,
  resolveAvailablePath,
} from '../src/main/staging';

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo", 19s

const REPO_ROOT = resolve(import.meta.dirname, '..');
const deps = {
  ytDlpPath: join(REPO_ROOT, 'resources', 'binaries', 'yt-dlp'),
  ffmpegPath: join(REPO_ROOT, 'resources', 'binaries', 'ffmpeg'),
};

const [, , urlArg, formatArg] = process.argv;
const url = urlArg ?? DEFAULT_URL;
const format = (formatArg as Format | undefined) ?? 'best';

const outputFolder = join(homedir(), 'Downloads', 'Pluck-smoke');
mkdirSync(outputFolder, { recursive: true });

const smokeId = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const main = async (): Promise<void> => {
  console.log(`[smoke] fetching metadata for ${url}`);
  const meta = await fetchMetadata(url, deps);
  console.log(
    `[smoke] meta: ${meta.title} (${meta.extractor}${
      meta.durationSec ? `, ${Math.round(meta.durationSec)}s` : ''
    })`,
  );

  const tempFolder = await createTempFolder(tmpdir(), smokeId);
  console.log(`[smoke] temp: ${tempFolder}`);

  try {
    console.log(`[smoke] downloading (${format}) into temp`);
    let lastPercent = -1;
    const result = await runDownload(
      {
        url,
        format,
        tempFolder,
        onProgress: (event) => {
          const whole = Math.floor(event.percent);
          if (event.status !== 'downloading' || whole !== lastPercent) {
            lastPercent = whole;
            const speed = event.speed ?? '?';
            const eta = event.eta ?? '?';
            console.log(
              `[smoke] ${event.status} ${Number.isFinite(event.percent) ? `${event.percent}%` : '?%'} ${speed} eta=${eta}`,
            );
          }
        },
      },
      deps,
    );

    const finalPath = await resolveAvailablePath(outputFolder, basename(result.filePath));
    await moveFile(result.filePath, finalPath);
    console.log(`[smoke] done -> ${finalPath}`);
  } finally {
    await removeTempFolder(tempFolder);
  }
};

main().catch((err: unknown) => {
  if (err instanceof YtDlpPasswordRequiredError) {
    console.error('[smoke] password required for this URL');
  } else if (err instanceof YtDlpError) {
    console.error(`[smoke] yt-dlp error: ${err.message}`);
    if (err.stderr) {
      console.error('---stderr (last lines)---');
      console.error(err.stderr.split('\n').slice(-10).join('\n'));
    }
  } else {
    console.error('[smoke] unexpected error:', err);
  }
  process.exit(1);
});
