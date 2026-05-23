import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions, shell } from 'electron';
import { z } from 'zod';
import { IpcChannels } from '../shared/ipc-channels';
import {
  type FormatChoice,
  type ParseYtDlpCommandResult,
  PLAYLIST_ENTRY_CAP,
  type PlaylistContext,
  type PlaylistEntry,
  STATIC_FORMAT_CHOICES,
  STATIC_FORMAT_CHOICES_ORDERED,
} from '../shared/types';
import { testApiKey } from './api-key-test';
import { detectInstalledBrowsers } from './browser-detection';
import type { DownloadQueue } from './downloader/queue';
import { resolveFormatChoices } from './downloader/video/format-selector';
import {
  ApiKeyCredentialsSchema,
  BrowserNameSchema,
  DownloadRequestSchema,
  HttpUrlSchema,
  NonEmptyStringSchema,
  SecretNameSchema,
  StartPlaylistDownloadSchema,
  UpdateSettingsPatchSchema,
} from './ipc-schemas';
import type { MetadataCache } from './metadata-cache';
import type { SecretsStore } from './secrets';
import type { Settings, SettingsStore } from './settings';
import { transcribeDownload } from './transcription/transcriber';
import { checkForUpdate, installUpdate, type UpdateCheckResult } from './yt-dlp-updater/updater';
import { readCurrentYtDlpInstallation, type YtDlpInstallation } from './yt-dlp-updater/version';
import {
  buildDownloadArgs,
  extractKnownFlags,
  formatInvocationForDisplay,
  parseYtDlpCommand,
  URL_PLACEHOLDER_TOKEN,
} from './ytdlp/args';

/** Filesystem-safe slug extracted from a URL. Tries the most-recognizable
 * identifier first: a `?v=` param (YouTube watch URLs), then the last path
 * segment (Vimeo `/12345`, Zoom `/rec/play/xyz`), then just the hostname.
 * The full ID always includes a timestamp + random tail, so the slug
 * doesn't need to be unique on its own — it's purely for legibility. */
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

export type IpcDeps = {
  queue: DownloadQueue;
  metadataCache: MetadataCache;
  settings: SettingsStore;
  secrets: SecretsStore;
  /** Per-download temp-folder root. Used by OpenTempFolder +
   * ClearTempFolders. Per-id subfolders live directly underneath. */
  tempBaseDir: string;
  /** Path to the bundled ffmpeg binary. Used by the transcription
   * pipeline to extract audio from completed video downloads. */
  ffmpegPath: string;
  /** Closure over the runner's `fetchPlaylistEntries` — wired up by
   * main/index.ts so this module stays unaware of yt-dlp binary paths.
   * Reads the current `cookiesFromBrowser` setting at call time. */
  enumeratePlaylist: (
    url: string,
  ) => Promise<{ entries: PlaylistEntry[]; context: PlaylistContext | undefined }>;
  /** Fan-out for the LibraryCleared event. Wired in main/index.ts to
   * send to every live BrowserWindow so the renderer can wipe its
   * mirrored downloads Map. Kept as a callback so this module stays
   * unaware of Electron's BrowserWindow type. */
  broadcastLibraryCleared: () => void;
};

/** Wire all renderer→main and main→renderer IPC. Pure delegation to the
 * queue/cache; this module owns no download lifecycle itself anymore.
 * Every renderer→main handler `safeParse`s its payload against a Zod
 * schema from `ipc-schemas.ts` — a compromised renderer can send
 * arbitrary bytes through `ipcRenderer.invoke`, so the boundary
 * uniformly rejects (returns an error-shape result, or silently
 * no-ops on race-tolerant fire-and-forget handlers) before touching
 * any downstream state. */
export const registerIpcHandlers = (deps: IpcDeps): void => {
  ipcMain.handle(
    IpcChannels.StartDownload,
    (_event, payload: unknown): { id: string } | { error: string } => {
      const parsed = DownloadRequestSchema.safeParse(payload);
      if (!parsed.success) {
        return { error: 'Invalid URL.' };
      }
      return { id: deps.queue.enqueue(parsed.data) };
    },
  );
  ipcMain.handle(IpcChannels.CancelDownload, (_event, id: unknown) => {
    // Unknown / wrong-type ids are silently ignored — the renderer can
    // race the IPC against a row completing, and we don't want to error
    // on the loser of that race.
    const parsed = NonEmptyStringSchema.safeParse(id);
    if (!parsed.success) {
      return;
    }
    deps.queue.cancel(parsed.data);
  });
  ipcMain.handle(IpcChannels.GetInitialState, () => deps.queue.getAll());
  ipcMain.handle(IpcChannels.ShowInFinder, (_event, filePath: unknown) => {
    // macOS "Reveal in Finder" — opens the parent folder with the file
    // selected. No-op on a missing path (Electron handles internally).
    const parsed = NonEmptyStringSchema.safeParse(filePath);
    if (!parsed.success) {
      return;
    }
    shell.showItemInFolder(parsed.data);
  });
  ipcMain.handle(IpcChannels.OpenExternal, async (_event, url: unknown) => {
    // HttpUrlSchema rejects non-http schemes (file://, javascript:,
    // etc.) so a compromised renderer can't trick the OS into
    // opening arbitrary local resources.
    const parsed = HttpUrlSchema.safeParse(url);
    if (!parsed.success) {
      return;
    }
    await shell.openExternal(parsed.data);
  });
  ipcMain.handle(IpcChannels.PrefetchMetadata, (_event, url: unknown) => {
    const parsed = HttpUrlSchema.safeParse(url);
    if (!parsed.success) {
      return;
    }
    deps.metadataCache.prefetch(parsed.data);
  });
  ipcMain.handle(IpcChannels.GetSettings, () => deps.settings.get());
  ipcMain.handle(IpcChannels.UpdateSettings, (_event, patch: unknown) => {
    // Validate the full patch shape against the schema; bail to the
    // unchanged settings on any field that violates (rather than
    // dropping that one field — a renderer that sent garbage probably
    // sent more garbage, and surfacing a no-op response is the safer
    // default). Per-field "clear vs. leave alone" semantics (where the
    // renderer signals "clear this field" by sending null or empty
    // string under the key) are intrinsic to the patch API — Zod
    // can't distinguish key-absent from key-undefined in its parse
    // output, so we read the raw payload's keys here for that one
    // distinction.
    const parsed = UpdateSettingsPatchSchema.safeParse(patch);
    if (!parsed.success || patch === null || typeof patch !== 'object') {
      return deps.settings.get();
    }
    const rawKeys = new Set(Object.keys(patch as object));
    const sanitized: Partial<Settings> = {};
    if (parsed.data.outputFolder !== undefined) {
      sanitized.outputFolder = parsed.data.outputFolder;
    }
    // cookies: explicit null OR key-present-with-undefined OR key
    // present at all + parse-value-null → clear. A BrowserName value
    // → set.
    if (rawKeys.has('cookiesFromBrowser')) {
      sanitized.cookiesFromBrowser = parsed.data.cookiesFromBrowser ?? undefined;
    }
    if (parsed.data.debugMode !== undefined) {
      sanitized.debugMode = parsed.data.debugMode;
    }
    if (parsed.data.concurrentFragments !== undefined) {
      sanitized.concurrentFragments = parsed.data.concurrentFragments;
    }
    if (parsed.data.concurrentDownloads !== undefined) {
      sanitized.concurrentDownloads = parsed.data.concurrentDownloads;
    }
    // override: same key-presence-means-touch semantics as cookies.
    // Empty string is normalized to "clear" (undefined) so users can
    // save partial / in-progress commands without the IPC bouncing
    // the update.
    if (rawKeys.has('ytDlpCommandOverride')) {
      const override = parsed.data.ytDlpCommandOverride;
      sanitized.ytDlpCommandOverride =
        override === null || override === undefined || override === '' ? undefined : override;
    }
    if (parsed.data.developerSectionOpen !== undefined) {
      sanitized.developerSectionOpen = parsed.data.developerSectionOpen;
    }
    if (parsed.data.transcriptionEnabled !== undefined) {
      sanitized.transcriptionEnabled = parsed.data.transcriptionEnabled;
    }
    if (parsed.data.ytDlpAutoUpdate !== undefined) {
      sanitized.ytDlpAutoUpdate = parsed.data.ytDlpAutoUpdate;
    }
    if (Object.keys(sanitized).length === 0) {
      return deps.settings.get();
    }
    return deps.settings.update(sanitized);
  });
  ipcMain.handle(IpcChannels.ChooseOutputFolder, async (event) => {
    // Anchor the dialog to the window that invoked us so it behaves as a
    // sheet on macOS rather than a free-floating window. Falling back
    // to the modeless overload when we can't find an owning window keeps
    // the dialog usable in edge cases (renderer reload races).
    const owner = BrowserWindow.fromWebContents(event.sender);
    const current = deps.settings.get().outputFolder;
    const dialogOptions: OpenDialogOptions = {
      title: 'Choose download folder',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use this folder',
    };
    const result = await (owner
      ? dialog.showOpenDialog(owner, dialogOptions)
      : dialog.showOpenDialog(dialogOptions));
    const picked = result.filePaths[0];
    if (result.canceled || !picked) {
      return undefined;
    }
    await deps.settings.update({ outputFolder: picked });
    return picked;
  });
  ipcMain.handle(IpcChannels.RetryDownload, (_event, id: unknown) => {
    const parsed = NonEmptyStringSchema.safeParse(id);
    if (!parsed.success) {
      return { id: undefined };
    }
    const original = deps.queue.getAll().find((d) => d.id === parsed.data);
    if (!original) {
      return { id: undefined };
    }
    // Build a fresh request from the original row's URL+format. Don't
    // carry the original's outputFolder forward — the user may have
    // changed the default in settings since the first attempt, and
    // re-using the old folder would be confusing.
    const newId = deps.queue.enqueue({ url: original.url, format: original.format });
    return { id: newId };
  });
  ipcMain.handle(IpcChannels.SubmitPassword, (_event, id: unknown, password: unknown) => {
    // An empty password is meaningless and would just waste an
    // attempt; silently ignore (both args must be non-empty strings).
    // Same race-tolerant pattern as Cancel — unknown ids are no-ops.
    const parsedId = NonEmptyStringSchema.safeParse(id);
    const parsedPassword = NonEmptyStringSchema.safeParse(password);
    if (!parsedId.success || !parsedPassword.success) {
      return;
    }
    deps.queue.submitPassword(parsedId.data, parsedPassword.data);
  });
  ipcMain.handle(
    IpcChannels.SubmitCookiesBrowser,
    async (_event, id: unknown, browser: unknown): Promise<void> => {
      // Two-step: persist the new browser choice as a global setting
      // (so subsequent unrelated downloads pick it up too), then nudge
      // the specific row that's waiting in 'needs_cookies' back to
      // 'queued'. Unknown id or invalid browser silently no-ops to
      // match the race-tolerance of submitPassword.
      const parsedId = NonEmptyStringSchema.safeParse(id);
      const parsedBrowser = BrowserNameSchema.safeParse(browser);
      if (!parsedId.success || !parsedBrowser.success) {
        return;
      }
      await deps.settings.update({ cookiesFromBrowser: parsedBrowser.data });
      deps.queue.retryWithCookies(parsedId.data);
    },
  );
  ipcMain.handle(IpcChannels.HasApiKeys, () => ({
    anthropic: deps.secrets.hasKey('anthropic'),
    elevenlabs: deps.secrets.hasKey('elevenlabs'),
  }));
  ipcMain.handle(IpcChannels.TestApiKey, (_event, name: unknown, key: unknown) => {
    const parsed = ApiKeyCredentialsSchema.safeParse({ name, key });
    if (!parsed.success) {
      return { ok: false, error: 'Missing provider or key.' };
    }
    return testApiKey(parsed.data.name, parsed.data.key);
  });
  ipcMain.handle(IpcChannels.SaveApiKey, async (_event, name: unknown, key: unknown) => {
    const parsed = ApiKeyCredentialsSchema.safeParse({ name, key });
    if (!parsed.success) {
      return { ok: false, error: 'Missing provider or key.' };
    }
    try {
      await deps.secrets.setKey(parsed.data.name, parsed.data.key);
      return { ok: true };
    } catch (err) {
      // EncryptionUnavailableError is the user-facing case; anything else
      // is a disk / write failure. Both collapse to a safe message here.
      const message = err instanceof Error ? err.message : 'Failed to save the key.';
      return { ok: false, error: message };
    }
  });
  ipcMain.handle(IpcChannels.DeleteApiKey, async (_event, name: unknown) => {
    // `name === undefined` (or any non-SecretName value) means "delete
    // all keys" — the Settings panel's reset flow. A specific
    // SecretName deletes only that one.
    if (name === undefined || name === null) {
      await deps.secrets.deleteAll();
      return;
    }
    const parsed = SecretNameSchema.safeParse(name);
    if (parsed.success) {
      await deps.secrets.deleteKey(parsed.data);
    }
  });
  ipcMain.handle(IpcChannels.GetAppVersion, () => app.getVersion());
  ipcMain.handle(IpcChannels.DetectInstalledBrowsers, () => detectInstalledBrowsers());
  ipcMain.handle(IpcChannels.OpenTempFolder, async (_event, id: unknown) => {
    const parsed = NonEmptyStringSchema.safeParse(id);
    if (!parsed.success) {
      return { ok: false, error: 'Invalid download id.' };
    }
    // The id is filesystem-safe by construction (generateDownloadId
    // sanitises segments). Still, validate that the resolved path
    // stays under the temp base — defense against any future id
    // generator that lets `..` through.
    const target = join(deps.tempBaseDir, parsed.data);
    if (!target.startsWith(`${deps.tempBaseDir}/`)) {
      return { ok: false, error: 'Path escape blocked.' };
    }
    const error = await shell.openPath(target);
    if (error.length > 0) {
      // shell.openPath returns the error string when the open failed
      // (typical post-success case: the temp folder has been cleaned).
      return { ok: false, error };
    }
    return { ok: true };
  });
  ipcMain.handle(IpcChannels.ClearTempFolders, async () => {
    // Walk + remove every per-download subfolder. ENOENT on the base
    // dir is fine — there's just nothing to clear. We swallow per-
    // entry errors so a single stuck folder doesn't abort the sweep.
    let entries: string[];
    try {
      entries = await fs.readdir(deps.tempBaseDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { cleared: 0, skippedActive: 0 };
      }
      throw err;
    }
    // Skip any subfolder whose name matches an active (non-terminal)
    // download id. yt-dlp is writing into those right now; rm-ing
    // them out from under it would corrupt the in-flight download.
    // The user can re-run Clear once those finish.
    const activeIds = new Set(
      deps.queue
        .getAll()
        .filter((d) => d.status === 'downloading' || d.status === 'canceling')
        .map((d) => d.id),
    );
    let cleared = 0;
    let skippedActive = 0;
    await Promise.all(
      entries.map(async (entry) => {
        if (activeIds.has(entry)) {
          skippedActive += 1;
          return;
        }
        try {
          await fs.rm(join(deps.tempBaseDir, entry), {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50,
          });
          cleared += 1;
        } catch (err) {
          console.error('clearTempFolders: failed to remove', entry, err);
        }
      }),
    );
    return { cleared, skippedActive };
  });
  ipcMain.handle(
    IpcChannels.ParseYtDlpCommand,
    (_event, input: unknown): ParseYtDlpCommandResult => {
      const parsedInput = z.string().safeParse(input);
      if (!parsedInput.success) {
        return { ok: false, error: 'Expected a string.' };
      }
      const parsed = parseYtDlpCommand(parsedInput.data);
      if (!parsed.ok) {
        return parsed;
      }
      return { ok: true, argv: parsed.argv, extracted: extractKnownFlags(parsed.argv) };
    },
  );
  ipcMain.handle(IpcChannels.GetInvocationPreview, (_event, url: unknown): string => {
    // Settings preview: shape the user's settings (cookies, -N,
    // override, default format args) into the exact argv the runner
    // would spawn for a hypothetical download. Placeholder strings
    // stand in for the per-download bits the preview can't know
    // ahead of time — tempFolder and the ffmpeg binary path — so
    // the user sees one stable command instead of a per-row tempdir
    // shuffle.
    const parsedUrl = NonEmptyStringSchema.safeParse(url);
    const targetUrl = parsedUrl.success ? parsedUrl.data : URL_PLACEHOLDER_TOKEN;
    const settings = deps.settings.get();
    const { args } = buildDownloadArgs(
      {
        url: targetUrl,
        tempFolder: '<TEMP>',
        ytDlpFormatArgs: STATIC_FORMAT_CHOICES.best.ytDlpFormatArgs,
        cookiesFromBrowser: settings.cookiesFromBrowser,
        concurrentFragments: settings.concurrentFragments,
        ytDlpCommandOverride: settings.ytDlpCommandOverride,
      },
      { ytDlpPath: 'yt-dlp', ffmpegPath: '<FFMPEG>' },
    );
    return formatInvocationForDisplay(args);
  });
  ipcMain.handle(
    IpcChannels.EnumeratePlaylist,
    async (
      _event,
      url: unknown,
    ): Promise<
      | { ok: true; entries: PlaylistEntry[]; context: PlaylistContext | undefined }
      | { ok: false; error: string }
    > => {
      const parsed = HttpUrlSchema.safeParse(url);
      if (!parsed.success) {
        return { ok: false, error: 'Invalid URL.' };
      }
      try {
        const result = await deps.enumeratePlaylist(parsed.data);
        return { ok: true, entries: result.entries, context: result.context };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to expand the playlist.';
        return { ok: false, error: message };
      }
    },
  );
  ipcMain.handle(
    IpcChannels.StartPlaylistDownload,
    (_event, payload: unknown): { ids: string[]; enqueued: number; skipped: number } => {
      // Whole-payload schema validation — rejects empty entries
      // arrays, missing format / context, unknown PlaylistOrder
      // values, malformed entry URLs. The handler's own logic then
      // re-orders + slices the validated entries.
      const parsed = StartPlaylistDownloadSchema.safeParse(payload);
      if (!parsed.success) {
        return { ids: [], enqueued: 0, skipped: 0 };
      }
      const { entries, format, playlistContext, order } = parsed.data;
      // Newest-first = reverse the playlist-ordered enumeration.
      const ordered = order === 'newest_first' ? [...entries].reverse() : entries;
      // Cap at PLAYLIST_ENTRY_CAP. The renderer warns the user when
      // this kicks in; we enforce it here too as defense in depth.
      const limited = ordered.slice(0, PLAYLIST_ENTRY_CAP);
      const skipped = ordered.length - limited.length;
      const total = limited.length;
      const ids: string[] = [];
      for (let i = 0; i < limited.length; i += 1) {
        const entry = limited[i];
        if (!entry || !HttpUrlSchema.safeParse(entry.url).success) {
          // The outer schema validates entry SHAPE; per-entry URL is
          // re-validated here so a single bad URL from a quirky
          // enumerate result skips just that row instead of tanking
          // the whole batch.
          continue;
        }
        ids.push(
          deps.queue.enqueue({
            url: entry.url,
            format,
            playlistId: playlistContext.id,
            playlistTitle: playlistContext.title,
            playlistIndex: i + 1,
            playlistTotal: total,
          }),
        );
      }
      return { ids, enqueued: ids.length, skipped };
    },
  );
  ipcMain.handle(IpcChannels.FileExists, async (_event, filePath: unknown): Promise<boolean> => {
    // Defensive: only stat absolute paths. A compromised renderer
    // could otherwise probe arbitrary fs (e.g. via a relative path
    // resolved against electron's cwd).
    const parsed = NonEmptyStringSchema.safeParse(filePath);
    if (!parsed.success || !parsed.data.startsWith('/')) {
      return false;
    }
    try {
      await fs.access(parsed.data);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle(
    IpcChannels.GetFormatChoices,
    async (
      _event,
      url: unknown,
    ): Promise<{ choices: FormatChoice[]; playlistContext?: PlaylistContext }> => {
      // Renderer probes per URL. We reuse the existing metadataCache —
      // if the URL was prefetched on paste this is free; if not, we
      // trigger a fresh fetch on demand. Silent fallback to the four
      // static defaults on any failure: invalid URL, network down,
      // private video without cookies, etc. The actual download attempt
      // will surface any real error. The metadata's `playlistContext`
      // is bubbled up alongside the choices so the renderer can pop the
      // PlaylistPrompt modal when the user clicks Download.
      const parsed = HttpUrlSchema.safeParse(url);
      if (!parsed.success) {
        return { choices: [...STATIC_FORMAT_CHOICES_ORDERED] };
      }
      try {
        const meta = await deps.metadataCache.get(parsed.data);
        return {
          choices: resolveFormatChoices(meta.formats),
          playlistContext: meta.playlistContext,
        };
      } catch (err) {
        console.error('GetFormatChoices: metadata fetch failed, returning static defaults', err);
        return { choices: [...STATIC_FORMAT_CHOICES_ORDERED] };
      }
    },
  );
  ipcMain.handle(IpcChannels.GetYtDlpStatus, async (): Promise<YtDlpInstallation> => {
    return readCurrentYtDlpInstallation();
  });
  ipcMain.handle(IpcChannels.CheckYtDlpUpdate, async (): Promise<UpdateCheckResult> => {
    return checkForUpdate();
  });
  ipcMain.handle(
    IpcChannels.InstallYtDlpUpdate,
    async (): Promise<{ ok: true; installedPath: string } | { ok: false; error: string }> => {
      return installUpdate();
    },
  );
  ipcMain.handle(IpcChannels.ClearLibrary, async (): Promise<void> => {
    deps.queue.clearAll();
    deps.broadcastLibraryCleared();
  });
  ipcMain.handle(
    IpcChannels.TranscribeDownload,
    async (_event, id: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
      // Resolve the download row first — the renderer should only
      // call this on completed rows, but defense-in-depth.
      const parsedId = NonEmptyStringSchema.safeParse(id);
      if (!parsedId.success) {
        return { ok: false, error: 'Invalid download id.' };
      }
      const row = deps.queue.getAll().find((d) => d.id === parsedId.data);
      if (!row) {
        return { ok: false, error: 'Download not found.' };
      }
      if (row.status !== 'completed' || !row.filePath) {
        return { ok: false, error: 'Download not yet completed.' };
      }
      if (
        row.transcriptionStatus &&
        row.transcriptionStatus.state !== 'idle' &&
        row.transcriptionStatus.state !== 'done' &&
        row.transcriptionStatus.state !== 'error'
      ) {
        // Already in flight — silently ignore the duplicate click.
        return { ok: true };
      }
      const apiKey = await deps.secrets.getKey('elevenlabs');
      if (!apiKey) {
        return { ok: false, error: 'Add an ElevenLabs API key in Settings first.' };
      }

      // Fire-and-forget the pipeline. Status updates flow back to
      // the renderer via the existing DownloadUpdate channel as the
      // queue's patchTranscription emits. The IPC call returns
      // immediately so the renderer doesn't block on the
      // transcription duration.
      void (async () => {
        try {
          const srtPath = await transcribeDownload(
            apiKey,
            row.filePath as string,
            (status) => {
              deps.queue.patchTranscription(parsedId.data, {
                transcriptionStatus: status,
                ...(status.state === 'done' ? { transcriptPath: status.srtPath } : {}),
              });
            },
            { ffmpegPath: deps.ffmpegPath, tempBaseDir: deps.tempBaseDir },
          );
          // Belt + suspenders: the onStatus 'done' callback already
          // patched the row, but make sure transcriptPath landed if
          // a future refactor decoupled the callback from the path.
          void srtPath;
        } catch (err) {
          // The transcriber already emitted `{state: 'error'}` via
          // onStatus before throwing. Log here for diagnostics.
          console.error('Transcription failed for', parsedId.data, err);
        }
      })();

      return { ok: true };
    },
  );
};
