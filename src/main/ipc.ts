import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { app, ipcMain, type WebContents } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type { Download, DownloadRequest } from '../shared/types';
import { binPath } from './paths';
import { createTempFolder, moveFile, removeTempFolder, resolveAvailablePath } from './staging';
import { fetchMetadata, runDownload } from './ytdlp/runner';
import { type RunnerDeps, YtDlpError, YtDlpPasswordRequiredError } from './ytdlp/types';

const DEFAULT_OUTPUT_FOLDER = join(homedir(), 'Downloads', 'Pluck');

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
  mkdirSync(outputFolder, { recursive: true });
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
    // Per-download workspace inside the OS temp dir. yt-dlp downloads
    // fragments and writes the merged output here; on success we move the
    // final file into outputFolder and rm the workspace. On any failure
    // the `finally` rm still fires, so user-visible Downloads/Pluck never
    // sees partial files.
    const tempFolder = await createTempFolder(app.getPath('temp'), id);
    try {
      const meta = await fetchMetadata(request.url, deps);
      emit({
        title: meta.title,
        sourceSite: meta.extractor,
        durationSec: meta.durationSec,
      });

      const result = await runDownload(
        {
          url: request.url,
          format: request.format,
          tempFolder,
          videoPassword: request.videoPassword,
          onProgress: (event) => {
            emit({
              progress: Number.isFinite(event.percent) ? event.percent : snapshot.progress,
              speed: event.speed,
              eta: event.eta,
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
};
