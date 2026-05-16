import { execFile, spawn } from 'node:child_process';
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

// Emit one JSON object per progress tick. Routed to stderr by default since
// `--progress-template` without an explicit destination targets the progress
// stream, and yt-dlp's progress stream is stderr. Keeping stdout free for
// `--print` output (the final file path) means the two streams parse cleanly
// without disambiguation logic.
const PROGRESS_TEMPLATE = [
  '{',
  '"status":"%(progress.status)s",',
  '"percent":"%(progress._percent_str)s",',
  '"speed":"%(progress._speed_str)s",',
  '"eta":"%(progress._eta_str)s"',
  '}',
].join('');

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
 * Download a single URL. Resolves with the final file path once yt-dlp
 * completes the post-move (handles --audio-format mp3 / merging cases).
 *
 * Progress is streamed via `onProgress`; the parent should debounce on its
 * side if it's pushing into UI state.
 */
export const runDownload = (
  opts: RunDownloadOptions,
  deps: RunnerDeps,
): Promise<RunDownloadResult> => {
  return new Promise<RunDownloadResult>((resolve, reject) => {
    const args = [
      '--newline',
      '--no-mtime',
      '--ffmpeg-location',
      deps.ffmpegPath,
      '--paths',
      `home:${opts.outputFolder}`,
      '-o',
      '%(title)s.%(ext)s',
      '--progress-template',
      PROGRESS_TEMPLATE,
      '--print',
      'after_move:%(filepath)s',
      ...formatFlags(opts.format),
    ];

    if (opts.videoPassword) {
      args.push('--video-password', opts.videoPassword);
    }

    args.push(opts.url);

    const child = spawn(deps.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let finalFilePath: string | undefined;
    const stderrChunks: string[] = [];

    const stdoutReader = createInterface({ input: child.stdout });
    stdoutReader.on('line', (line) => {
      const trimmed = line.trim();
      // The only `--print` is `after_move:%(filepath)s`, so any non-empty
      // stdout line is the final file path. Last one wins if yt-dlp emits
      // multiple (e.g. playlist URLs, though those aren't a v1 use case).
      if (trimmed.length > 0) {
        finalFilePath = trimmed;
      }
    });

    const stderrReader = createInterface({ input: child.stderr });
    stderrReader.on('line', (line) => {
      const event = parseProgressLine(line);
      if (event) {
        opts.onProgress?.(event);
        return;
      }
      // Retain non-progress lines for error context. Cap to last ~256 lines
      // so a chatty failure doesn't balloon memory.
      stderrChunks.push(line);
      if (stderrChunks.length > 256) {
        stderrChunks.shift();
      }
    });

    child.on('error', (err) => {
      reject(new YtDlpError(`Failed to spawn yt-dlp: ${err.message}`));
    });

    child.on('close', (code) => {
      const stderr = stderrChunks.join('\n');
      if (code !== 0) {
        if (isPasswordRequiredError(stderr)) {
          reject(new YtDlpPasswordRequiredError(stderr));
          return;
        }
        reject(new YtDlpError(`yt-dlp exited with code ${code}`, stderr));
        return;
      }
      if (!finalFilePath) {
        reject(new YtDlpError('yt-dlp completed but did not report a file path', stderr));
        return;
      }
      resolve({ filePath: finalFilePath });
    });
  });
};
