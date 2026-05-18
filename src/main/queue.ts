import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import type { DebugLogEvent, DebugLogPhase, Download, DownloadRequest } from '../shared/types';
import type { MetadataCache } from './metadata-cache';
import { createProgressSmoother } from './progress-smoother';
import { createTempFolder, moveFile, removeTempFolder, resolveAvailablePath } from './staging';
import type { RunDownloadOptions, RunDownloadResult, RunnerDeps } from './ytdlp/types';
import { YtDlpCancelledError, YtDlpPasswordRequiredError } from './ytdlp/types';

/** Spec: max 3 concurrent downloads. Above this every additional URL waits
 * in 'queued' until a slot opens. Inter-download parallelism — separate
 * from yt-dlp's -N 14 intra-download parallelism. */
const MAX_CONCURRENT = 3;

/** Padding so very fast downloads (a YouTube Short at -N 14 finishes in
 * one frame) still let the progress bar paint at least once before the
 * row jumps straight to 'completed'. Failure paths are not padded. */
const MIN_VISIBLE_DOWNLOADING_MS = 500;

/** After this many wrong password submissions on the same row, give up
 * and mark the row 'failed'. Matches the spec's 3-attempt cap. */
const MAX_PASSWORD_ATTEMPTS = 3;

/** Throttle for `download:progress` debug log entries — yt-dlp fires
 * progress multiple times a second, but the log box doesn't need that
 * resolution. One entry per second is plenty to follow the trend. */
const DEBUG_PROGRESS_THROTTLE_MS = 1000;

/** Filesystem errno → user-facing message. Stderr / absolute paths never
 * reach the renderer; this lookup is what stays safe. */
const FS_ERRNO_MESSAGES: Record<string, string> = {
  ENOSPC: 'No space left on the destination disk.',
  EACCES: 'Permission denied when saving the download.',
  EPERM: 'Permission denied when saving the download.',
  EROFS: 'The destination is read-only.',
  ENOENT: 'The destination folder no longer exists.',
};

/** Translate a thrown error into a user-facing string. Stderr and absolute
 * paths are deliberately not echoed back. Exported so the IPC layer can
 * reuse the same mapping if it ever needs to. */
export const friendlyErrorMessage = (err: unknown): string => {
  if (err instanceof YtDlpCancelledError) {
    // Defense in depth: queue should route cancellation through the
    // 'cancelled' status path, never here. If something accidentally
    // does, at least produce a non-scary string.
    return 'Download cancelled.';
  }
  if (err instanceof YtDlpPasswordRequiredError) {
    // Defense in depth: the queue catches this error and routes it
    // through the 'needs_password' status path, never here. If somehow
    // it reaches this branch (e.g. a non-queue caller), at least
    // produce a useful message rather than the generic one.
    return 'This recording requires a password.';
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === 'string') {
      return FS_ERRNO_MESSAGES[code] ?? 'Could not save the download.';
    }
    // Generic yt-dlp / unknown errors collapse to a safe message. Echoing
    // err.message would leak stderr / paths via the Node fs error shape.
    return 'Download failed. The site may be unsupported or the URL may be invalid.';
  }
  return 'Download failed.';
};

/** Sleep until `minMs` has elapsed since `startMs`. No-op if past. Exported
 * for testing. */
export const padToMinDuration = async (startMs: number, minMs: number): Promise<void> => {
  const elapsed = Date.now() - startMs;
  if (elapsed >= minMs) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
};

/** Function shape of `runDownload` from ytdlp/runner. Injected so tests can
 * supply a fake that resolves on demand instead of spawning real yt-dlp. */
export type RunDownloadFn = (
  opts: RunDownloadOptions,
  deps: RunnerDeps,
) => Promise<RunDownloadResult>;

export type QueueOptions = {
  /** Read on every enqueue so a settings change takes effect on the
   * next new download without rebuilding the queue. In-flight rows
   * keep the folder they started with (snapshotted in their Download
   * struct at enqueue time). Overridden per-request by
   * DownloadRequest.outputFolder when present. */
  getDefaultOutputFolder: () => string;
  /** Read at runOne time so a settings change takes effect on the
   * next started row. Currently-running rows aren't affected — yt-dlp
   * is already past the metadata phase. Undefined = don't pass
   * `--cookies-from-browser`. */
  getCookiesFromBrowser: () => string | undefined;
  /** Read at every emit point. When false, the queue does no debug
   * work — no event construction, no raw-stderr subscription, no
   * skip-cleanup-on-failure. Cheap default state. */
  getDebugMode: () => boolean;
  /** Receives lifecycle + raw-stderr events. Called only when
   * getDebugMode() is true, so the implementation can assume "user
   * wants to see this" — typically fans out via the DebugLog IPC
   * channel. */
  onDebugLog?: (event: DebugLogEvent) => void;
  /** Base dir for per-download workspaces (~/Library/Caches/video.pluck.app/). */
  tempBaseDir: string;
  /** Path to yt-dlp + ffmpeg, passed through to the runner. */
  runnerDeps: RunnerDeps;
  /** The actual runner. Inject in production from ytdlp/runner; tests use a
   * fake that resolves/rejects on cue so they don't spawn real processes. */
  runDownload: RunDownloadFn;
  /** Shared metadata cache (prefetched by the renderer on URL paste). */
  metadataCache: MetadataCache;
  /** Per-id generator. Owned by the caller so it can stay deterministic in tests. */
  generateId: (url: string) => string;
  /** Fired on every state change so the IPC layer can push to the renderer. */
  onUpdate: (download: Download) => void;
  /** Fired on every visible state change — new row, status transition, or
   * terminal — so the caller can persist. The queue passes the full
   * current snapshot; the caller decides what to keep (e.g. history.save
   * with capping). NOT fired for in-status progress patches (smoothed
   * speed / ETA / percent) — those happen multiple times a second and
   * persisting each would thrash the disk. */
  onPersistChange?: (downloads: Download[]) => void;
};

export type DownloadQueue = {
  /** Add a download request. Returns its id immediately. Starts running if
   * a slot is free, otherwise stays in 'queued' until one opens. */
  enqueue(request: DownloadRequest): string;
  /** Cancel by id. Aborts the yt-dlp child if running; just removes from
   * the queue if still 'queued' (no process to kill). No-op if the id is
   * already in a terminal state or unknown. */
  cancel(id: string): void;
  /** Deliver a password for a row that's waiting in 'needs_password'.
   * Re-runs the download with the supplied password as `--video-password`.
   * After MAX_PASSWORD_ATTEMPTS failures the row terminates as 'failed'
   * instead of asking again. No-op if the id isn't currently in
   * 'needs_password' (renderer / IPC race). */
  submitPassword(id: string, password: string): void;
  /** All known downloads, oldest-first by createdAt. */
  getAll(): Download[];
  /** Boot path: seed the queue with persisted history. Does NOT start any
   * downloads — these are already in terminal states (the rehydrate step
   * in history.ts promotes in-flight to 'failed' before we get here). */
  rehydrate(downloads: Download[]): void;
};

export const createDownloadQueue = (opts: QueueOptions): DownloadQueue => {
  // Authoritative state. Renderer's Zustand store mirrors this via the
  // onUpdate stream — never the other way around.
  const state = new Map<string, Download>();
  // Side-table for the per-request secret (video password). Kept off the
  // Download struct so it can't accidentally land in history.json and so
  // the renderer never sees it via the update stream.
  const secrets = new Map<string, string>();
  // Per-download AbortController. Present only for active runs; pruned on
  // terminal state. cancel() aborts; the runner sees the signal and rejects
  // with YtDlpCancelledError.
  const abortControllers = new Map<string, AbortController>();
  let activeCount = 0;

  const persist = (): void => {
    opts.onPersistChange?.([...state.values()]);
  };

  /** Emit a debug log event iff debug mode is on. The outer guard means
   * the message-construction cost (e.g. JSON.stringify on metadata) is
   * also skipped in the off case — callers should pass a thunk if the
   * message is expensive, but most calls just pass a string literal. */
  const emitDebug = (id: string, phase: DebugLogPhase, message: string): void => {
    if (!opts.getDebugMode()) {
      return;
    }
    opts.onDebugLog?.({ id, phase, message, timestamp: Date.now() });
  };

  const emit = (id: string, patch: Partial<Download> = {}): void => {
    const current = state.get(id);
    if (!current) {
      return;
    }
    const next = { ...current, ...patch };
    state.set(id, next);
    opts.onUpdate(next);
    // Persist whenever the visible status changes — covers queued→
    // downloading, downloading→canceling, →completed, →failed, →cancelled.
    // Pure progress patches (same status) don't trigger a save.
    if (current.status !== next.status) {
      persist();
    }
  };

  const isTerminal = (status: Download['status']): boolean =>
    status === 'completed' || status === 'failed' || status === 'cancelled';

  const tryStartNext = (): void => {
    if (activeCount >= MAX_CONCURRENT) {
      return;
    }
    // FIFO: oldest queued first. Map iteration order is insertion order,
    // which is exactly what we want — enqueue order == display order.
    for (const download of state.values()) {
      if (download.status === 'queued') {
        void runOne(download.id);
        if (activeCount >= MAX_CONCURRENT) {
          return;
        }
      }
    }
  };

  const runOne = async (id: string): Promise<void> => {
    const download = state.get(id);
    if (!download || download.status !== 'queued') {
      return;
    }

    activeCount += 1;
    const abortController = new AbortController();
    abortControllers.set(id, abortController);

    emit(id, { status: 'downloading' });

    const outputFolder = download.outputFolder;
    const tempFolder = await createTempFolder(opts.tempBaseDir, id);
    // Tracks the last `download:progress` debug log emit so we can
    // throttle to ~1/sec — yt-dlp progress fires multiple times per
    // second, but the user reading the log box doesn't need that. Set
    // to 0 so the first progress event always emits.
    let lastDebugProgressAt = 0;
    try {
      await fs.mkdir(outputFolder, { recursive: true });

      emitDebug(id, 'metadata:start', download.url);
      const meta = await opts.metadataCache.get(download.url);
      // Note: the metadata cache was warmed at URL paste with the
      // cookies setting that was active *at paste time*. If the user
      // changes cookies between paste and download, the cached
      // metadata might be from the wrong browser context. The actual
      // download below uses the live setting, so it'll still work —
      // we just might show a slightly stale title/thumbnail.
      emit(id, {
        title: meta.title,
        sourceSite: meta.extractor,
        durationSec: meta.durationSec,
        thumbnailUrl: meta.thumbnailUrl,
      });
      emitDebug(id, 'metadata:done', `${meta.extractor}: ${meta.title}`);

      const smoother = createProgressSmoother();
      emitDebug(id, 'download:start', `format=${download.format}`);
      const result = await opts.runDownload(
        {
          url: download.url,
          format: download.format,
          tempFolder,
          videoPassword: secrets.get(id),
          cookiesFromBrowser: opts.getCookiesFromBrowser(),
          cancelSignal: abortController.signal,
          // Subscribe to the raw stderr/stdout firehose only when
          // debug mode is on — otherwise the closure-per-line cost is
          // pure waste. Captured at runOne entry; a settings toggle
          // during the run won't take effect until the next row.
          onRawLine: opts.getDebugMode() ? (line) => emitDebug(id, 'ytdlp', line) : undefined,
          onProgress: (event) => {
            smoother.sample(event.speed, event.eta);
            const smoothed = smoother.current();
            const currentSnapshot = state.get(id);
            emit(id, {
              progress: Number.isFinite(event.percent)
                ? event.percent
                : (currentSnapshot?.progress ?? 0),
              speed: smoothed.speed,
              eta: smoothed.eta,
            });
            // Throttled lifecycle log — gives a once-per-second
            // "we're alive" entry without flooding the log box. The
            // outer emitDebug guard skips when debug mode is off, so
            // we don't even pay the Date.now() cost most of the time.
            if (opts.getDebugMode()) {
              const now = Date.now();
              if (now - lastDebugProgressAt >= DEBUG_PROGRESS_THROTTLE_MS) {
                lastDebugProgressAt = now;
                emitDebug(
                  id,
                  'download:progress',
                  `${smoothed.speed ?? '—'} · ETA ${smoothed.eta ?? '—'}`,
                );
              }
            }
          },
        },
        opts.runnerDeps,
      );
      emitDebug(id, 'download:done', result.filePath);

      emitDebug(id, 'move:start', outputFolder);
      const finalPath = await resolveAvailablePath(outputFolder, basename(result.filePath));
      await moveFile(result.filePath, finalPath);
      emitDebug(id, 'move:done', finalPath);

      await padToMinDuration(download.createdAt, MIN_VISIBLE_DOWNLOADING_MS);

      emit(id, {
        status: 'completed',
        progress: 100,
        filePath: finalPath,
        completedAt: Date.now(),
        speed: undefined,
        eta: undefined,
      });
    } catch (err) {
      if (err instanceof YtDlpCancelledError) {
        emit(id, {
          status: 'cancelled',
          completedAt: Date.now(),
          speed: undefined,
          eta: undefined,
        });
      } else if (err instanceof YtDlpPasswordRequiredError) {
        // Row waits in 'needs_password' until the renderer submits one
        // (or the user gives up). Once MAX attempts are spent we stop
        // asking and terminate — otherwise a wrong-password loop has no
        // exit. attempts counts *submitted* passwords that were wrong;
        // the first natural prompt (no submission yet) doesn't count.
        const attempts = state.get(id)?.passwordAttempts ?? 0;
        if (attempts >= MAX_PASSWORD_ATTEMPTS) {
          emit(id, {
            status: 'failed',
            error: `Incorrect password (${MAX_PASSWORD_ATTEMPTS} attempts).`,
            speed: undefined,
            eta: undefined,
          });
        } else {
          emit(id, { status: 'needs_password', speed: undefined, eta: undefined });
        }
      } else {
        const message = friendlyErrorMessage(err);
        emitDebug(id, 'error', message);
        emit(id, {
          status: 'failed',
          error: message,
          speed: undefined,
          eta: undefined,
        });
      }
    } finally {
      abortControllers.delete(id);
      activeCount -= 1;
      // Debug mode preserves the temp folder for failed downloads so
      // the user can inspect yt-dlp's fragments + merged output. The
      // success / cancelled / needs_password paths still clean up —
      // success has nothing useful left; cancel was the user's intent
      // anyway. needs_password is non-terminal so the next run reuses
      // the slot but a fresh temp folder.
      const finalStatus = state.get(id)?.status;
      const keepTemp = opts.getDebugMode() && finalStatus === 'failed';
      if (!keepTemp) {
        await removeTempFolder(tempFolder);
        emitDebug(id, 'cleanup:done', tempFolder);
      } else {
        emitDebug(id, 'cleanup:done', `kept for inspection: ${tempFolder}`);
      }
      // Always drop the secret after a run. submitPassword writes a
      // fresh one for the next attempt, so survival between runs has
      // no functional effect — and dropping eagerly keeps the secrets
      // map bounded to actively-running rows.
      secrets.delete(id);
      // Terminal status was already persisted via the emit() above;
      // no extra save needed here.
      // Slot opened up — see if another queued row can now start.
      tryStartNext();
    }
  };

  const enqueue = (request: DownloadRequest): string => {
    const id = opts.generateId(request.url);
    const download: Download = {
      id,
      url: request.url,
      format: request.format,
      outputFolder: request.outputFolder ?? opts.getDefaultOutputFolder(),
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
    };
    state.set(id, download);
    if (request.videoPassword) {
      secrets.set(id, request.videoPassword);
    }
    opts.onUpdate(download);
    // New row — persist immediately so an app crash before the first
    // status transition still leaves the row in history (otherwise it'd
    // be lost and the user would never know they tried to download it).
    persist();
    tryStartNext();
    return id;
  };

  const cancel = (id: string): void => {
    const download = state.get(id);
    if (!download || isTerminal(download.status) || download.status === 'canceling') {
      return;
    }
    if (download.status === 'needs_password') {
      // Waiting on the user; no process to kill, just terminate. The
      // password (if any was set) gets dropped along with the row.
      secrets.delete(id);
      emit(id, { status: 'cancelled', completedAt: Date.now() });
      return;
    }
    if (download.status === 'queued') {
      // Never spawned a process; just flip the state. No abort controller,
      // no temp folder, no slot to release. emit() will persist via the
      // status transition.
      secrets.delete(id);
      emit(id, { status: 'cancelled', completedAt: Date.now() });
      return;
    }
    // Active download — emit 'canceling' optimistically so the row reflects
    // the click immediately (yt-dlp may take up to the 2 s SIGKILL grace
    // to actually exit). The abort signal does the rest; runner rejects
    // with YtDlpCancelledError and runOne's catch emits the terminal
    // 'cancelled'.
    emit(id, { status: 'canceling', speed: undefined, eta: undefined });
    abortControllers.get(id)?.abort();
  };

  const submitPassword = (id: string, password: string): void => {
    const download = state.get(id);
    // Only a row in 'needs_password' is waiting on us. Races (user
    // submits twice / submits after retry already kicked off) are
    // ignored rather than queueing duplicate runs.
    if (!download || download.status !== 'needs_password') {
      return;
    }
    secrets.set(id, password);
    // Bump the attempt counter and flip back to 'queued'; tryStartNext
    // will promote it through runOne with the fresh secret.
    emit(id, {
      status: 'queued',
      passwordAttempts: (download.passwordAttempts ?? 0) + 1,
    });
    tryStartNext();
  };

  const getAll = (): Download[] => [...state.values()];

  const rehydrate = (downloads: Download[]): void => {
    for (const download of downloads) {
      state.set(download.id, download);
    }
  };

  return { enqueue, cancel, submitPassword, getAll, rehydrate };
};
