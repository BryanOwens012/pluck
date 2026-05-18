import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions, shell } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import { BROWSER_NAMES, type BrowserName, type DownloadRequest } from '../shared/types';
import { isHttpUrl } from '../shared/url';
import { testApiKey } from './api-key-test';
import { detectInstalledBrowsers } from './browser-detection';
import type { MetadataCache } from './metadata-cache';
import type { DownloadQueue } from './queue';
import { SECRET_NAMES, type SecretName, type SecretsStore } from './secrets';
import type { Settings, SettingsStore } from './settings';

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
};
