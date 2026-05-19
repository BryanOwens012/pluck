import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions, shell } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import {
  BROWSER_NAMES,
  type BrowserName,
  type DownloadRequest,
  type FormatChoice,
  type ParseYtDlpCommandResult,
  STATIC_FORMAT_CHOICES,
  STATIC_FORMAT_CHOICES_ORDERED,
} from '../shared/types';
import { isHttpUrl } from '../shared/url';
import { testApiKey } from './api-key-test';
import { detectInstalledBrowsers } from './browser-detection';
import { resolveFormatChoices } from './format-selector';
import type { MetadataCache } from './metadata-cache';
import type { DownloadQueue } from './queue';
import { SECRET_NAMES, type SecretName, type SecretsStore } from './secrets';
import {
  MAX_CONCURRENT_DOWNLOADS,
  MAX_CONCURRENT_FRAGMENTS,
  MIN_CONCURRENT_DOWNLOADS,
  MIN_CONCURRENT_FRAGMENTS,
  type Settings,
  type SettingsStore,
} from './settings';
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
};

/** Type-guard so the IPC layer can reject unknown provider names from a
 * compromised renderer rather than blindly calling SecretsStore. */
const isSecretName = (value: unknown): value is SecretName =>
  typeof value === 'string' && (SECRET_NAMES as readonly string[]).includes(value);

/** Same guard idea for the cookiesFromBrowser dropdown value — an invalid
 * string would silently break the next yt-dlp invocation otherwise. */
const isBrowserName = (value: unknown): value is BrowserName =>
  typeof value === 'string' && (BROWSER_NAMES as readonly string[]).includes(value);

/** Wire all renderer→main and main→renderer IPC. Pure delegation to the
 * queue/cache; this module owns no download lifecycle itself anymore. */
export const registerIpcHandlers = (deps: IpcDeps): void => {
  ipcMain.handle(IpcChannels.StartDownload, (_event, request: DownloadRequest) => {
    return { id: deps.queue.enqueue(request) };
  });
  ipcMain.handle(IpcChannels.CancelDownload, (_event, id: unknown) => {
    // Unknown / wrong-type ids are silently ignored — the renderer can
    // race the IPC against a row completing, and we don't want to error
    // on the loser of that race.
    if (typeof id !== 'string') {
      return;
    }
    deps.queue.cancel(id);
  });
  ipcMain.handle(IpcChannels.GetInitialState, () => deps.queue.getAll());
  ipcMain.handle(IpcChannels.ShowInFinder, (_event, filePath: string) => {
    // macOS "Reveal in Finder" — opens the parent folder with the file
    // selected. No-op on a missing path (Electron handles internally).
    shell.showItemInFolder(filePath);
  });
  ipcMain.handle(IpcChannels.OpenExternal, async (_event, url: unknown) => {
    // isHttpUrl gate: a compromised renderer could otherwise pass `file://`
    // and trick the OS into opening arbitrary local files.
    if (!isHttpUrl(url)) {
      return;
    }
    await shell.openExternal(url);
  });
  ipcMain.handle(IpcChannels.PrefetchMetadata, (_event, url: unknown) => {
    // Same gate as OpenExternal — never invoke yt-dlp on arbitrary schemes.
    if (!isHttpUrl(url)) {
      return;
    }
    deps.metadataCache.prefetch(url);
  });
  ipcMain.handle(IpcChannels.GetSettings, () => deps.settings.get());
  ipcMain.handle(IpcChannels.UpdateSettings, (_event, patch: unknown) => {
    // Defense in depth: only the keys we accept are forwarded to disk.
    // A compromised renderer shouldn't be able to write arbitrary
    // properties to settings.json. Each key is validated for shape
    // before merging.
    if (typeof patch !== 'object' || patch === null) {
      return deps.settings.get();
    }
    const patchObj = patch as Record<string, unknown>;
    const sanitized: Partial<Settings> = {};
    const folder = patchObj.outputFolder;
    if (typeof folder === 'string' && folder.length > 0) {
      sanitized.outputFolder = folder;
    }
    // For cookiesFromBrowser the "clear" intent matters as much as the
    // "set" intent — the user picks 'None' to stop sending the flag.
    // We detect intent by *key presence* (renderer sends the key with
    // a null/undefined value to clear); a missing key means "no change
    // to this field". Both null and undefined survive structured-clone
    // IPC with the key intact, so this check is the wire-safe one.
    if ('cookiesFromBrowser' in patchObj) {
      const cookies = patchObj.cookiesFromBrowser;
      if (cookies === null || cookies === undefined) {
        sanitized.cookiesFromBrowser = undefined;
      } else if (isBrowserName(cookies)) {
        sanitized.cookiesFromBrowser = cookies;
      }
    }
    if (typeof patchObj.debugMode === 'boolean') {
      sanitized.debugMode = patchObj.debugMode;
    }
    if (
      typeof patchObj.concurrentFragments === 'number' &&
      Number.isInteger(patchObj.concurrentFragments) &&
      patchObj.concurrentFragments >= MIN_CONCURRENT_FRAGMENTS &&
      patchObj.concurrentFragments <= MAX_CONCURRENT_FRAGMENTS
    ) {
      sanitized.concurrentFragments = patchObj.concurrentFragments;
    }
    if (
      typeof patchObj.concurrentDownloads === 'number' &&
      Number.isInteger(patchObj.concurrentDownloads) &&
      patchObj.concurrentDownloads >= MIN_CONCURRENT_DOWNLOADS &&
      patchObj.concurrentDownloads <= MAX_CONCURRENT_DOWNLOADS
    ) {
      sanitized.concurrentDownloads = patchObj.concurrentDownloads;
    }
    // ytDlpCommandOverride: empty string and undefined / null both
    // mean "clear the override" (auto mode). Any non-empty string is
    // accepted as-is; contents are validated at use time by the
    // tokenizer, not here, so users can save partial / in-progress
    // commands without the IPC bouncing the update.
    if ('ytDlpCommandOverride' in patchObj) {
      const override = patchObj.ytDlpCommandOverride;
      if (override === null || override === undefined || override === '') {
        sanitized.ytDlpCommandOverride = undefined;
      } else if (typeof override === 'string') {
        sanitized.ytDlpCommandOverride = override;
      }
    }
    if (typeof patchObj.developerSectionOpen === 'boolean') {
      sanitized.developerSectionOpen = patchObj.developerSectionOpen;
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
    if (typeof id !== 'string') {
      return { id: undefined };
    }
    const original = deps.queue.getAll().find((d) => d.id === id);
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
    // Both shape-check and length-check. An empty password is meaningless
    // and would just waste an attempt; silently ignore. Same race-tolerant
    // pattern as Cancel — unknown ids are no-ops.
    if (typeof id !== 'string' || typeof password !== 'string' || password.length === 0) {
      return;
    }
    deps.queue.submitPassword(id, password);
  });
  ipcMain.handle(IpcChannels.HasApiKeys, () => ({
    anthropic: deps.secrets.hasKey('anthropic'),
    elevenlabs: deps.secrets.hasKey('elevenlabs'),
  }));
  ipcMain.handle(IpcChannels.TestApiKey, (_event, name: unknown, key: unknown) => {
    if (!isSecretName(name) || typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: 'Missing provider or key.' };
    }
    return testApiKey(name, key);
  });
  ipcMain.handle(IpcChannels.SaveApiKey, async (_event, name: unknown, key: unknown) => {
    if (!isSecretName(name) || typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: 'Missing provider or key.' };
    }
    try {
      await deps.secrets.setKey(name, key);
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
    // all keys" — the Settings panel's reset flow. A specific name
    // deletes only that one.
    if (name === undefined || name === null) {
      await deps.secrets.deleteAll();
      return;
    }
    if (isSecretName(name)) {
      await deps.secrets.deleteKey(name);
    }
  });
  ipcMain.handle(IpcChannels.GetAppVersion, () => app.getVersion());
  ipcMain.handle(IpcChannels.DetectInstalledBrowsers, () => detectInstalledBrowsers());
  ipcMain.handle(IpcChannels.OpenTempFolder, async (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'Invalid download id.' };
    }
    // The id is filesystem-safe by construction (generateDownloadId
    // sanitises segments). Still, validate that the resolved path
    // stays under the temp base — defense against any future id
    // generator that lets `..` through.
    const target = join(deps.tempBaseDir, id);
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
      if (typeof input !== 'string') {
        return { ok: false, error: 'Expected a string.' };
      }
      const parsed = parseYtDlpCommand(input);
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
    const targetUrl = typeof url === 'string' && url.length > 0 ? url : URL_PLACEHOLDER_TOKEN;
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
  ipcMain.handle(IpcChannels.FileExists, async (_event, filePath: unknown): Promise<boolean> => {
    // Defensive: only stat absolute paths owned by a download row.
    // A compromised renderer otherwise could probe arbitrary fs.
    if (typeof filePath !== 'string' || filePath.length === 0 || !filePath.startsWith('/')) {
      return false;
    }
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle(
    IpcChannels.GetFormatChoices,
    async (_event, url: unknown): Promise<FormatChoice[]> => {
      // Renderer probes per URL. We reuse the existing metadataCache —
      // if the URL was prefetched on paste this is free; if not, we
      // trigger a fresh fetch on demand. Silent fallback to the four
      // static defaults on any failure: invalid URL, network down,
      // private video without cookies, etc. The actual download attempt
      // will surface any real error.
      if (!isHttpUrl(url)) {
        return [...STATIC_FORMAT_CHOICES_ORDERED];
      }
      try {
        const meta = await deps.metadataCache.get(url);
        return resolveFormatChoices(meta.formats);
      } catch (err) {
        console.error('GetFormatChoices: metadata fetch failed, returning static defaults', err);
        return [...STATIC_FORMAT_CHOICES_ORDERED];
      }
    },
  );
};
