import { join } from 'node:path';
import type { FetchMetadataOptions, RunDownloadOptions, RunnerDeps } from './types';

/** Default for yt-dlp `-N` (parallel HTTP connections per single
 * download) when the caller doesn't specify. yt-dlp's own default is 1
 * (serial); 14 saturates most home connections without enough per-
 * server load to trip rate limits on the sites we target (YouTube,
 * Vimeo, Zoom). The user can override this per-app via Settings →
 * Developer → Concurrent fragments (1-20). */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 14;

/** yt-dlp's `-J` JSON metadata output can be large (extractor fields,
 * full `formats` array). 100 MB is well above what we'd ever see for
 * a single video and below Node's default JSON parser ceiling. */
export const METADATA_MAX_BUFFER = 100 * 1024 * 1024;

/** Max stderr lines retained for the close-handler's error parsing.
 * yt-dlp can emit hundreds of lines on a broken extractor; we only
 * need the recent ones to diagnose. Older lines drop off the front. */
export const MAX_STDERR_RETENTION_LINES = 256;

/** SIGTERM → SIGKILL grace period on cancellation. Lets yt-dlp wind
 * down its child ffmpeg before we force-kill. 2 s matches the macOS
 * `kill` man page recommendation for non-essential daemons. */
export const CANCEL_FORCE_KILL_AFTER_MS = 2000;

/** yt-dlp `--progress-template` JSON shape. Emitted on stdout once per
 * progress tick, parsed by parser.ts. yt-dlp writes both its info
 * chatter and this template to stdout (despite the conventional split);
 * parseProgressLine returns null for non-JSON noise lines. */
const PROGRESS_TEMPLATE = [
  '{',
  '"status":"%(progress.status)s",',
  '"percent":"%(progress._percent_str)s",',
  '"speed":"%(progress._speed_str)s",',
  '"eta":"%(progress._eta_str)s"',
  '}',
].join('');

/** yt-dlp writes the final post-move filepath here via `--print-to-file`.
 * We can't use plain `--print` because it activates implicit quiet mode
 * and silences both the info chatter and the `--progress-template`
 * output. The marker file lives inside the per-download tempFolder so
 * removeTempFolder() reaps it automatically. The leading "." keeps it
 * out of Finder by default. */
export const FINAL_PATH_MARKER_FILENAME = '.pluck-final-path';

// Format args are no longer constructed per-preset here. They live on
// FormatChoice in shared/types.ts (STATIC_FORMAT_CHOICES for the four
// default presets; format-selector.ts builds per-URL choices including
// the optional 5th non-mp4 alternative). buildDownloadArgs receives
// the already-built args as opts.ytDlpFormatArgs and spreads them
// straight into argv — runner stays oblivious to format semantics.

/** Build the argv for `yt-dlp -J --no-download <url>` (metadata fetch).
 * Pure function — no side effects, no spawn. Runner consumes the
 * returned array directly. */
export const buildMetadataArgs = (url: string, options: FetchMetadataOptions): string[] => {
  const args = ['-J', '--no-download'];
  if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  }
  args.push(url);
  return args;
};

/** Build the argv for a full `yt-dlp` download invocation. The marker
 * path is returned alongside the args because the runner needs it to
 * read the final filepath yt-dlp writes via `--print-to-file`. */
export const buildDownloadArgs = (
  opts: RunDownloadOptions,
  deps: RunnerDeps,
): { args: string[]; markerPath: string } => {
  const markerPath = join(opts.tempFolder, FINAL_PATH_MARKER_FILENAME);
  const args = [
    '--newline',
    '--no-mtime',
    '-N',
    String(opts.concurrentFragments ?? DEFAULT_DOWNLOAD_CONCURRENCY),
    '--ffmpeg-location',
    deps.ffmpegPath,
    '--paths',
    `home:${opts.tempFolder}`,
    '-o',
    '%(title)s.%(ext)s',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--print-to-file',
    'after_move:%(filepath)s',
    markerPath,
    ...opts.ytDlpFormatArgs,
  ];

  if (opts.videoPassword) {
    args.push('--video-password', opts.videoPassword);
  }
  if (opts.cookiesFromBrowser) {
    args.push('--cookies-from-browser', opts.cookiesFromBrowser);
  }
  args.push(opts.url);

  return { args, markerPath };
};
