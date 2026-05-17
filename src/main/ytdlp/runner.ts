import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { Format } from '../../shared/types';
import { isPasswordRequiredError, parseMetadata, parseProgressLine } from './parser';
import {
  type RunDownloadOptions,
  type RunDownloadResult,
  type RunnerDeps,
  type VideoMetadata,
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

// Parallel HTTP connections yt-dlp opens per single download (`-N`). yt-dlp's
// default is 1 (serial); 14 saturates most home connections without enough
// per-server load to trip rate limits on the sites we target (YouTube,
// Vimeo, Zoom). This is *intra-download* parallelism (chunks of one video);
// the queue's max-3 in PR 5 is *inter-download* parallelism — a separate
// axis. With 3 concurrent downloads at -N 14 we top out at ~42 sockets,
// well under any consumer machine's limit.
const DOWNLOAD_CONCURRENCY = 14;

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

const formatFlags = (format: Format): string[] => {
  switch (format) {
    case 'best':
      return ['-f', 'bv*+ba/b'];
    case '1080p':
      return ['-f', 'bv*[height<=1080]+ba/b[height<=1080]'];
    case '720p':
      return ['-f', 'bv*[height<=720]+ba/b[height<=720]'];
    case 'audio_mp3':
      return ['-x', '--audio-format', 'mp3', '--audio-quality', '0'];
  }
};

/**
 * Run `yt-dlp -J --no-download` to fetch video metadata without downloading
 * any media. Used by the queue to populate the row with a title before the
 * download starts streaming.
 */
export const fetchMetadata = async (url: string, deps: RunnerDeps): Promise<VideoMetadata> => {
  try {
    const { stdout } = await execFileAsync(deps.ytDlpPath, ['-J', '--no-download', url], {
      maxBuffer: METADATA_MAX_BUFFER,
    });
    return parseMetadata(stdout);
  } catch (err) {
    if (err instanceof Error && 'stderr' in err && typeof err.stderr === 'string') {
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
 * Progress is streamed via `onProgress`; the parent should debounce on its
 * side if it's pushing into UI state.
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
      String(DOWNLOAD_CONCURRENCY),
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

    args.push(opts.url);

    const child = spawn(deps.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stderrChunks: string[] = [];

    // yt-dlp progress + chatter both come on stdout. parseProgressLine
    // returns null for the non-JSON noise (`[youtube] ...`, `[download]
    // Destination: ...`, etc.) so we don't need to pre-filter.
    const stdoutReader = createInterface({ input: child.stdout });
    stdoutReader.on('line', (line) => {
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
      stderrChunks.push(line);
      if (stderrChunks.length > MAX_STDERR_RETENTION_LINES) {
        stderrChunks.shift();
      }
    });

    child.on('error', (err) => {
      reject(new YtDlpError(`Failed to spawn yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      void (async (): Promise<void> => {
        const stderr = stderrChunks.join('\n');
        if (code !== 0) {
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
