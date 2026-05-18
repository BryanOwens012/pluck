import { join } from 'node:path';
import type { Format } from '../../shared/types';
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

/** yt-dlp `-S` (sort) criteria used by every video preset. Tells yt-dlp:
 *  - Prefer the highest *resolution* within the format selector's
 *    constraints (so within `height<=1080`, pick the 1080p variant).
 *  - Within that resolution, prefer the highest *fps* (1080p60 beats
 *    1080p30 when both are available — sports, games, smooth pans).
 *  - Within that, prefer the canonical *vcodec* ordering (h264 inside
 *    mp4 containers — universal compatibility with QuickTime / iMovie).
 *
 * Used together with the `[ext=mp4]` format-selector constraint so the
 * pick is always (a) mp4 and (b) the best mp4 by the criteria above. */
const VIDEO_SORT_CRITERIA = 'res,fps,vcodec';

/** mp4-default video preset format strings. Spec PR 9.6 Phase A:
 *  - Always prefer mp4 container → plays in QuickTime / iMessage /
 *    iMovie / Photos without re-encoding. (YouTube's vp9/webm streams
 *    don't play in any of those.)
 *  - Falls back to a single-file mp4 (`b[ext=mp4]`) if no separate
 *    video+audio mp4 streams exist for this URL.
 *  - Audio defaults to m4a, the mp4-container-native audio codec.
 *
 * Trade-off: 4K is often vp9/webm-only on YouTube, so "best" here caps
 * at the highest available mp4 (typically 1080p on YouTube, sometimes
 * 1440p on Vimeo). PR 9.6b will add an optional 5th dropdown choice
 * that surfaces the absolute-best non-mp4 when it strictly beats the
 * mp4 pick — opt-in 4K-webm for users who know what they're picking. */
export const formatFlags = (format: Format): string[] => {
  switch (format) {
    case 'best':
      return ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]', '-S', VIDEO_SORT_CRITERIA];
    case '1080p':
      return [
        '-f',
        'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]',
        '-S',
        VIDEO_SORT_CRITERIA,
      ];
    case '720p':
      return [
        '-f',
        'bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]',
        '-S',
        VIDEO_SORT_CRITERIA,
      ];
    case 'audio_mp3':
      // Audio extraction is post-decode: yt-dlp picks the best audio
      // source (any container) and ffmpeg re-encodes to mp3. No
      // container preference matters since the output is mp3 either
      // way; no -S sort needed for the same reason.
      return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  }
};

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
    ...formatFlags(opts.format),
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
