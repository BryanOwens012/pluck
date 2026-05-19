import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { PlaylistContext, PlaylistEntry } from '../../shared/types';
import {
  buildDownloadArgs,
  buildMetadataArgs,
  buildPlaylistEnumerationArgs,
  CANCEL_FORCE_KILL_AFTER_MS,
  MAX_STDERR_RETENTION_LINES,
  METADATA_MAX_BUFFER,
} from './args';
import {
  isCookieAccessDeniedError,
  isPasswordRequiredError,
  parseMetadata,
  parsePlaylistContextFromFlat,
  parsePlaylistEntries,
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
  const args = buildMetadataArgs(url, options);
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
 * Run `yt-dlp -J --no-download --yes-playlist --flat-playlist` to enumerate
 * a playlist's entries without per-video metadata round-trips. Used by the
 * "All videos in playlist" path to learn what to enqueue. Returns the parsed
 * entries plus the playlist's own id/title/count for the row labels.
 *
 * Throws the same friendly errors as `fetchMetadata` (cookies denied,
 * password required, generic) so the caller can route them through the
 * same UI message paths.
 */
export const fetchPlaylistEntries = async (
  url: string,
  deps: RunnerDeps,
  options: FetchMetadataOptions = {},
): Promise<{ entries: PlaylistEntry[]; context: PlaylistContext | undefined }> => {
  const args = buildPlaylistEnumerationArgs(url, options);
  try {
    const { stdout } = await execFileAsync(deps.ytDlpPath, args, {
      maxBuffer: METADATA_MAX_BUFFER,
    });
    return {
      entries: parsePlaylistEntries(stdout),
      context: parsePlaylistContextFromFlat(stdout),
    };
  } catch (err) {
    if (err instanceof Error && 'stderr' in err && typeof err.stderr === 'string') {
      if (options.cookiesFromBrowser && isCookieAccessDeniedError(err.stderr)) {
        throw new YtDlpCookieAccessDeniedError(options.cookiesFromBrowser, err.stderr);
      }
      if (isPasswordRequiredError(err.stderr)) {
        throw new YtDlpPasswordRequiredError(err.stderr);
      }
      throw new YtDlpError(`yt-dlp playlist enumeration failed: ${err.message}`, err.stderr);
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
    const { args, markerPath } = buildDownloadArgs(opts, deps);
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
