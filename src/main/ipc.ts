import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ipcMain, shell, type WebContents } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type { Download, DownloadRequest } from '../shared/types';
import { binPath } from './paths';
import { createProgressSmoother } from './progress-smoother';
import { createTempFolder, moveFile, removeTempFolder, resolveAvailablePath } from './staging';
import { fetchMetadata, runDownload } from './ytdlp/runner';
import { type RunnerDeps, YtDlpError, YtDlpPasswordRequiredError } from './ytdlp/types';

const DEFAULT_OUTPUT_FOLDER = join(homedir(), 'Downloads', 'Pluck');

/** Per-download workspaces live under `~/Library/Caches/video.pluck.app/`.
 * Predictable path (vs Electron's randomized `app.getPath('temp')`), same
 * APFS volume as ~/Downloads so the move-out stays atomic, and macOS may
 * auto-purge under "Optimize Storage" pressure — free hygiene on top of
 * our own try/finally cleanup. The literal `video.pluck.app` matches the
 * electron-builder appId so it remains stable across dev and packaged
 * builds. */
const PLUCK_CACHE_DIR = join(homedir(), 'Library', 'Caches', 'video.pluck.app');

/** Minimum time the row stays in the `downloading` state on the renderer.
 * Tiny videos (YouTube Shorts at -N 14) finish in well under a frame, which
 * makes the row flash straight to `completed` — the progress bar never
 * renders. Padding the transition guarantees the user sees the bar at
 * least briefly, regardless of file size. Failure paths are NOT padded —
 * errors should surface immediately. */
const MIN_VISIBLE_DOWNLOADING_MS = 500;

const buildRunnerDeps = (): RunnerDeps => ({
  ytDlpPath: binPath('yt-dlp'),
  ffmpegPath: binPath('ffmpeg'),
});

/** Filesystem-safe slug extracted from a URL. Tries the most-recognizable
 * identifier first: a `?v=` param (YouTube watch URLs), then the last path
 * segment (Vimeo `/12345`, Zoom `/rec/play/xyz`), then just the hostname.
 * The full ID always includes a timestamp + random tail, so we don't need
 * the slug to be unique on its own — it's purely for human legibility. */
const urlSlug = (url: string): string => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').split('.')[0] ?? 'download';
    const vParam = parsed.searchParams.get('v');
    if (vParam) {
      return `${host}-${sanitizeSegment(vParam)}`;
    }
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
    if (lastSegment) {
      return `${host}-${sanitizeSegment(lastSegment)}`;
    }
    return host;
  } catch {
    return 'download';
  }
};

const sanitizeSegment = (segment: string): string =>
  segment.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);

/** Local-time stamp: YYYYMMDD-HHMMSS. Sortable as a string and readable at
 * a glance ("dl from this morning vs. last week"). */
const formatTimestamp = (date: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${ymd}-${hms}`;
};

/** Legible download id: `<url-slug>-<YYYYMMDD-HHMMSS>-<rand6>`. The slug and
 * timestamp make logs / React keys / future history-file entries scannable;
 * the random tail guarantees uniqueness within the same second. Exported
 * for testing. */
export const generateDownloadId = (url: string, now: Date = new Date()): string => {
  const slug = urlSlug(url);
  const stamp = formatTimestamp(now);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${slug}-${stamp}-${rand}`;
};

/** Plain-English mapping for common filesystem errno codes thrown by the
 * staging step (mkdir, rename, copyFile). Keeps absolute paths from leaking
 * into user-facing strings — Node's default error message format is
 * `EXXX: description, syscall '/absolute/path/...'`. */
const FS_ERRNO_MESSAGES: Record<string, string> = {
  ENOSPC: 'No space left on the destination disk.',
  EACCES: 'Permission denied when saving the download.',
  EPERM: 'Permission denied when saving the download.',
  EROFS: 'The destination is read-only.',
  ENOENT: 'The destination folder no longer exists.',
};

/** Sleep until `minMs` has elapsed since `startMs`. No-op if already past.
 * Exported for testing. */
export const padToMinDuration = async (startMs: number, minMs: number): Promise<void> => {
  const elapsed = Date.now() - startMs;
  if (elapsed >= minMs) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
};

/** Translate a thrown error into a user-facing message. Stderr is never sent
 * to the renderer — it's noisy and can leak filesystem paths. Exported for
 * testing. */
export const friendlyErrorMessage = (err: unknown): string => {
  if (err instanceof YtDlpPasswordRequiredError) {
    return 'This recording requires a password.';
  }
  if (err instanceof YtDlpError) {
    return 'Download failed. The site may be unsupported or the URL may be invalid.';
  }
  if (err instanceof Error) {
    // NodeJS.ErrnoException — fs ops at the staging/move step. Map to a
    // safe message; never echo err.message verbatim because it includes
    // the absolute path of the failing operation.
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') {
      return FS_ERRNO_MESSAGES[code] ?? 'Could not save the download.';
    }
    return err.message;
  }
  return 'Download failed.';
};

const handleStartDownload = (
  webContents: WebContents,
  request: DownloadRequest,
): { id: string } => {
  const id = generateDownloadId(request.url);
  const outputFolder = request.outputFolder ?? DEFAULT_OUTPUT_FOLDER;
  const deps = buildRunnerDeps();

  // Per-download mutable snapshot. Each update emits a full Download object
  // so the renderer can replace by id without merging partials.
  let snapshot: Download = {
    id,
    url: request.url,
    format: request.format,
    outputFolder,
    status: 'downloading',
    progress: 0,
    createdAt: Date.now(),
  };

  const emit = (patch: Partial<Download> = {}): void => {
    snapshot = { ...snapshot, ...patch };
    if (!webContents.isDestroyed()) {
      webContents.send(IpcChannels.DownloadUpdate, snapshot);
    }
  };

  // Initial emission so the renderer can show the row immediately, before
  // the metadata pre-pass completes.
  emit();

  // Fire and forget: the IPC contract only requires that the id come back
  // synchronously; everything else streams through DownloadUpdate.
  void (async (): Promise<void> => {
    // Per-download workspace inside ~/Library/Caches/video.pluck.app/.
    // yt-dlp downloads fragments and writes the merged output here; on
    // success we move the final file into outputFolder and rm the
    // workspace. On any failure the `finally` rm still fires, so
    // user-visible Downloads/Pluck never sees partial files.
    const tempFolder = await createTempFolder(PLUCK_CACHE_DIR, id);
    try {
      // Ensure the user-visible output folder exists. Async so the IPC
      // handler's event loop isn't blocked on filesystem.
      await fs.mkdir(outputFolder, { recursive: true });

      const meta = await fetchMetadata(request.url, deps);
      emit({
        title: meta.title,
        sourceSite: meta.extractor,
        durationSec: meta.durationSec,
      });

      // Two-second smoother for speed + ETA. yt-dlp fires progress multiple
      // times per second; raw values flicker too fast to read. Percent is
      // NOT smoothed — bar should fill continuously.
      const smoother = createProgressSmoother();
      const result = await runDownload(
        {
          url: request.url,
          format: request.format,
          tempFolder,
          videoPassword: request.videoPassword,
          onProgress: (event) => {
            smoother.sample(event.speed, event.eta);
            const smoothed = smoother.current();
            emit({
              progress: Number.isFinite(event.percent) ? event.percent : snapshot.progress,
              speed: smoothed.speed,
              eta: smoothed.eta,
            });
          },
        },
        deps,
      );

      // Move the merged file out of temp into the user-visible folder.
      // Same-volume case (default): atomic rename. Cross-volume (external
      // drive): staging.ts falls back to copyFile + rm via EXDEV branch.
      const finalPath = await resolveAvailablePath(outputFolder, basename(result.filePath));
      await moveFile(result.filePath, finalPath);

      // Guarantee the row was visible in the `downloading` state long
      // enough for at least one progress-bar paint, even for sub-second
      // downloads (YouTube Shorts at -N 14 finish in a single frame).
      await padToMinDuration(snapshot.createdAt, MIN_VISIBLE_DOWNLOADING_MS);

      emit({
        status: 'completed',
        progress: 100,
        filePath: finalPath,
        completedAt: Date.now(),
        speed: undefined,
        eta: undefined,
      });
    } catch (err) {
      emit({
        status: 'failed',
        error: friendlyErrorMessage(err),
        speed: undefined,
        eta: undefined,
      });
    } finally {
      await removeTempFolder(tempFolder);
    }
  })();

  return { id };
};

export const registerIpcHandlers = (): void => {
  ipcMain.handle(IpcChannels.StartDownload, (event, request: DownloadRequest) =>
    handleStartDownload(event.sender, request),
  );
  ipcMain.handle(IpcChannels.ShowInFinder, (_event, filePath: string) => {
    // shell.showItemInFolder opens Finder showing the parent folder with the
    // file selected — the macOS "Reveal in Finder" gesture. No-op on a
    // missing path (Electron logs internally; nothing useful for renderer
    // to do about it).
    shell.showItemInFolder(filePath);
  });
};
