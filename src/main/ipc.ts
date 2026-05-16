import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ipcMain, type WebContents } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type { Download, DownloadRequest } from '../shared/types';
import { binPath } from './paths';
import { fetchMetadata, runDownload } from './ytdlp/runner';
import { type RunnerDeps, YtDlpError, YtDlpPasswordRequiredError } from './ytdlp/types';

const DEFAULT_OUTPUT_FOLDER = join(homedir(), 'Downloads', 'Pluck');

const runnerDeps = (): RunnerDeps => ({
  ytDlpPath: binPath('yt-dlp'),
  ffmpegPath: binPath('ffmpeg'),
});

/** Short, unique-per-process id. Not a UUID — we don't need collision-proof
 * across machines, only within a session. */
const generateDownloadId = (): string =>
  `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Translate a thrown error into a user-facing message. Stderr is never sent
 * to the renderer — it's noisy and can leak filesystem paths. */
const friendlyErrorMessage = (err: unknown): string => {
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
  const id = generateDownloadId();
  const outputFolder = request.outputFolder ?? DEFAULT_OUTPUT_FOLDER;
  mkdirSync(outputFolder, { recursive: true });

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

  const updateAndEmit = (patch: Partial<Download>): void => {
    snapshot = { ...snapshot, ...patch };
    if (!webContents.isDestroyed()) {
      webContents.send(IpcChannels.DownloadUpdate, snapshot);
    }
  };

  // Initial emission so the renderer can show the row immediately, before
  // the metadata pre-pass completes.
  updateAndEmit({});

  // Fire and forget: the IPC contract only requires that the id come back
  // synchronously; everything else streams through DownloadUpdate.
  void (async (): Promise<void> => {
    try {
      const meta = await fetchMetadata(request.url, runnerDeps());
      updateAndEmit({
        title: meta.title,
        sourceSite: meta.extractor,
        durationSec: meta.durationSec,
      });

      const result = await runDownload(
        {
          url: request.url,
          format: request.format,
          outputFolder,
          videoPassword: request.videoPassword,
          onProgress: (event) => {
            updateAndEmit({
              progress: Number.isFinite(event.percent) ? event.percent : snapshot.progress,
              speed: event.speed,
              eta: event.eta,
            });
          },
        },
        runnerDeps(),
      );

      updateAndEmit({
        status: 'completed',
        progress: 100,
        filePath: result.filePath,
        completedAt: Date.now(),
        speed: undefined,
        eta: undefined,
      });
    } catch (err) {
      updateAndEmit({
        status: 'failed',
        error: friendlyErrorMessage(err),
        speed: undefined,
        eta: undefined,
      });
    }
  })();

  return { id };
};

export const registerIpcHandlers = (): void => {
  ipcMain.handle(IpcChannels.StartDownload, (event, request: DownloadRequest) =>
    handleStartDownload(event.sender, request),
  );
};
