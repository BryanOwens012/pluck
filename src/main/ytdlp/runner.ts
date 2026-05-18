import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { Format } from '../../shared/types';
import {
  isCookieAccessDeniedError,
  isPasswordRequiredError,
  parseMetadata,
  parseProgressLine,
} from './parser';
import {
  type FetchMetadataOptions,
  type RunDownloadOptions,
  type RunDownloadResult,
  type RunnerDeps,
  type VideoMetadata,
  YtDlpCancelledError,
  YtDlpCookieAccessDeniedError,
  YtDlpError,
  YtDlpPasswordRequiredError,
} from './types';

const execFileAsync = promisify(execFile);

// yt-dlp `-J` output can be large; 100 MB is well above what we'd ever see
// for a single video and below Node's default JSON parser ceiling.
const METADATA_MAX_BUFFER = 100 * 1024 * 1024;

// Cap retained non-progress stderr so a chatty failure (yt-dlp can emit
// hundreds of lines on a broken extractor) doesn't balloon memory. The
// last N lines are what matter for diagnosing the failure.
const MAX_STDERR_RETENTION_LINES = 256;

// Default for yt-dlp `-N` (parallel HTTP connections per single download)
// when the caller doesn't specify. yt-dlp's own default is 1 (serial); 14
// saturates most home connections without enough per-server load to trip
// rate limits on the sites we target (YouTube, Vimeo, Zoom). This is
// *intra-download* parallelism (chunks of one video); the queue's max-3
// in PR 5 is *inter-download* parallelism — a separate axis. With 3
// concurrent downloads at -N 14 we top out at ~42 sockets, well under
// any consumer machine's limit. The user can override this per-app
// via Settings → Developer → Concurrent fragments (1-16).
const DEFAULT_DOWNLOAD_CONCURRENCY = 14;

// Emit one JSON object per progress tick. yt-dlp writes both its info chatter
// (`[youtube] Extracting URL: ...`) and the progress-template output to
// STDOUT; nothing useful goes to stderr unless something actually breaks.
// Our stdout reader passes every line through parseProgressLine — non-JSON
// lines return null and we drop them.
const PROGRESS_TEMPLATE = [
  '{',
  '"status":"%(progress.status)s",',
  '"percent":"%(progress._percent_str)s",',
  '"speed":"%(progress._speed_str)s",',
  '"eta":"%(progress._eta_str)s"',
  '}',
].join('');

// yt-dlp writes the final post-move filepath here via --print-to-file. We
// can't use plain --print because it activates implicit quiet mode and
// silences both the info chatter and the --progress-template output. The
// marker file lives inside the per-download tempFolder so removeTempFolder()
// reaps it automatically. The leading "." keeps it out of Finder by default.
const FINAL_PATH_MARKER_FILENAME = '.pluck-final-path';

// Grace period between SIGTERM and SIGKILL on cancellation. SIGTERM lets
// yt-dlp clean up its temp fragments and child ffmpeg process; SIGKILL is
// the unconditional fallback if it ignores SIGTERM. 2 s matches the macOS
// `kill` man page recommendation for non-essential daemons.
const CANCEL_FORCE_KILL_AFTER_MS = 2000;

/** yt-dlp `-S` (sort) criteria used by every video preset. Tells yt-dlp:
 *  - Prefer the highest *resolution* within the format selector's
 *    constraints (so within `height<=1080`, pick the 1080p variant
 *    over a 720p one).
 *  - Within that resolution, prefer the highest *fps* (so 1080p60
 *    beats 1080p30 when both are available — important for sports,
 *    games, smooth pans).
 *  - Within that, prefer the canonical *vcodec* ordering (yt-dlp's
 *    default vcodec preference list, which prefers h264 inside mp4
 *    containers — universal compatibility with QuickTime / iMovie).
 *
 * Used together with the `[ext=mp4]` format-selector constraint so the
 * pick is always (a) mp4 and (b) the best mp4 by the criteria above. */
const VIDEO_SORT = '-S';
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
const formatFlags = (format: Format): string[] => {
  switch (format) {
    case 'best':
      return ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]', VIDEO_SORT, VIDEO_SORT_CRITERIA];
    case '1080p':
      return [
        '-f',
        'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]',
        VIDEO_SORT,
        VIDEO_SORT_CRITERIA,
      ];
    case '720p':
      return [
        '-f',
        'bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]',
        VIDEO_SORT,
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

/**
 * Run `yt-dlp -J --no-download` to fetch video metadata without downloading
 * any media. Used by the queue to populate the row with a title before the
 * download starts streaming.
 */
export const fetchMetadata = async (
  url: string,
  deps: RunnerDeps,
  options: FetchMetadataOptions = {},
): Promise<VideoMetadata> => {
  const args = ['-J', '--no-download'];
  if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  }
  args.push(url);
  try {
    const { stdout } = await execFileAsync(deps.ytDlpPath, args, {
      maxBuffer: METADATA_MAX_BUFFER,
    });
    return parseMetadata(stdout);
  } catch (err) {
    if (err instanceof Error && 'stderr' in err && typeof err.stderr === 'string') {
      // Cookie-access-denied is checked BEFORE the password-required
      // signal because both can fire on Zoom (the user picked a
      // browser, macOS denied → yt-dlp may also report "passcode
      // required" downstream). The cookies failure is the upstream
      // cause; surfacing that is more actionable.
      if (options.cookiesFromBrowser && isCookieAccessDeniedError(err.stderr)) {
        throw new YtDlpCookieAccessDeniedError(options.cookiesFromBrowser, err.stderr);
      }
      if (isPasswordRequiredError(err.stderr)) {
        throw new YtDlpPasswordRequiredError(err.stderr);
      }
      throw new YtDlpError(`yt-dlp metadata fetch failed: ${err.message}`, err.stderr);
    }
    throw err;
  }
};

/**
 * Download a single URL into `opts.tempFolder`. yt-dlp handles the parallel
 * fragment download (-N), merge, and post-process; we resolve with the path
 * to the final file *inside the temp folder*. The caller (IPC handler /
 * smoke harness) is responsible for moving that file into the user-visible
 * output folder and cleaning up the temp folder.
 *
 * Progress is streamed via `onProgress` on every yt-dlp event — multiple
 * times per second. The IPC handler runs each callback through
 * `progress-smoother` before pushing to the renderer; standalone callers
 * (smoke harness) can take the raw stream as-is.
 */
export const runDownload = (
  opts: RunDownloadOptions,
  deps: RunnerDeps,
): Promise<RunDownloadResult> => {
  return new Promise<RunDownloadResult>((resolve, reject) => {
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

    const child = spawn(deps.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stderrChunks: string[] = [];

    // Tracks whether cancellation has been requested. The close handler
    // distinguishes "yt-dlp exited because the user cancelled" (reject
    // with YtDlpCancelledError) from "yt-dlp exited because something went
    // wrong" (reject with YtDlpError).
    let cancelled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const handleAbort = (): void => {
      cancelled = true;
      // SIGTERM first so yt-dlp can wind down its child ffmpeg cleanly.
      // If the process is still alive after the grace period, SIGKILL
      // unconditionally. `kill()` is a no-op if the process is already
      // dead — safe to call from both paths.
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, CANCEL_FORCE_KILL_AFTER_MS);
    };

    // If the caller pre-aborted, kick the abort path immediately. Otherwise
    // listen for abort events. Cleanup of the listener happens in the close
    // handler so we don't leak AbortSignal listeners across many downloads.
    if (opts.cancelSignal?.aborted) {
      handleAbort();
    } else {
      opts.cancelSignal?.addEventListener('abort', handleAbort, { once: true });
    }

    // yt-dlp progress + chatter both come on stdout. parseProgressLine
    // returns null for the non-JSON noise (`[youtube] ...`, `[download]
    // Destination: ...`, etc.) so we don't need to pre-filter.
    const stdoutReader = createInterface({ input: child.stdout });
    stdoutReader.on('line', (line) => {
      // Debug tap: forward every stdout line (progress JSON included)
      // when the caller wants the raw firehose. Cheap when off — the
      // optional chain skips the closure call entirely.
      opts.onRawLine?.(line);
      const event = parseProgressLine(line);
      if (event) {
        opts.onProgress?.(event);
      }
    });

    // stderr is reserved for actual errors (rare; yt-dlp tends to send
    // even errors to stdout). Keep a bounded ring buffer for diagnostics
    // on a non-zero exit.
    const stderrReader = createInterface({ input: child.stderr });
    stderrReader.on('line', (line) => {
      // Same debug tap on stderr — both streams flow to the log box
      // when on, so the user sees a complete picture of yt-dlp's
      // output without having to spawn it themselves.
      opts.onRawLine?.(line);
      stderrChunks.push(line);
      if (stderrChunks.length > MAX_STDERR_RETENTION_LINES) {
        stderrChunks.shift();
      }
    });

    child.on('error', (err) => {
      reject(new YtDlpError(`Failed to spawn yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      // Drop the force-kill timer + abort listener regardless of how we
      // got here. Without this the AbortSignal would keep our handler
      // alive across the lifetime of the cancelSignal (which the IPC
      // handler owns).
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      opts.cancelSignal?.removeEventListener('abort', handleAbort);

      void (async (): Promise<void> => {
        const stderr = stderrChunks.join('\n');
        // Cancellation wins over any other exit reason — yt-dlp killed by
        // SIGTERM/SIGKILL exits with a non-zero code, but we know why.
        if (cancelled) {
          reject(new YtDlpCancelledError());
          return;
        }
        if (code !== 0) {
          if (opts.cookiesFromBrowser && isCookieAccessDeniedError(stderr)) {
            reject(new YtDlpCookieAccessDeniedError(opts.cookiesFromBrowser, stderr));
            return;
          }
          if (isPasswordRequiredError(stderr)) {
            reject(new YtDlpPasswordRequiredError(stderr));
            return;
          }
          reject(new YtDlpError(`yt-dlp exited with code ${code}`, stderr));
          return;
        }
        // Read the after_move marker file yt-dlp wrote via --print-to-file.
        // Last line wins (the file uses append mode; in practice only one
        // line is ever written for our single-URL invocations).
        let markerContent: string;
        try {
          markerContent = await fs.readFile(markerPath, 'utf-8');
        } catch {
          reject(new YtDlpError('yt-dlp completed but did not report a file path', stderr));
          return;
        }
        const finalFilePath = markerContent
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);
        if (!finalFilePath) {
          reject(new YtDlpError('yt-dlp wrote an empty after_move marker file', stderr));
          return;
        }
        resolve({ filePath: finalFilePath });
      })();
    });
  });
};
