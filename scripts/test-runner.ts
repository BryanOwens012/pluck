/**
 * Smoke harness for src/main/ytdlp/runner.ts. Runs end-to-end against a real
 * URL using the bundled binaries in resources/binaries/. Stand-alone Node
 * script — does NOT boot Electron, so paths are resolved directly.
 *
 * Usage:
 *   npm run test:smoke                         # default short YouTube URL
 *   npm run test:smoke -- <url>                # custom URL
 *   npm run test:smoke -- <url> audio_mp3      # custom format
 *
 * Output: progress events streamed to stdout, then the final file path.
 *
 * This is intentionally not a Vitest test because it (a) hits the network,
 * (b) writes to ~/Downloads/Pluck-smoke/, and (c) takes several seconds.
 * The parser-level unit tests cover the deterministic edge cases.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Format } from '../src/shared/types';
import { fetchMetadata, runDownload } from '../src/main/ytdlp/runner';
import { YtDlpError, YtDlpPasswordRequiredError } from '../src/main/ytdlp/types';

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

const main = async (): Promise<void> => {
  console.log(`[smoke] fetching metadata for ${url}`);
  const meta = await fetchMetadata(url, deps);
  console.log(
    `[smoke] meta: ${meta.title} (${meta.extractor}${
      meta.durationSec ? `, ${Math.round(meta.durationSec)}s` : ''
    })`,
  );

  console.log(`[smoke] downloading (${format}) -> ${outputFolder}`);
  let lastPercent = -1;
  const result = await runDownload(
    {
      url,
      format,
      outputFolder,
      onProgress: (event) => {
        // Throttle to avoid spam: log on whole-percent boundaries and on terminal states.
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

  console.log(`[smoke] done -> ${result.filePath}`);
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
