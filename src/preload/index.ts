import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import type { SecretName } from '../main/secrets';
import type { Settings } from '../main/settings';
import { IpcChannels } from '../shared/ipc-channels';
import type { BrowserName, DebugLogEvent, Download, DownloadRequest } from '../shared/types';

export type HasApiKeys = { anthropic: boolean; elevenlabs: boolean };
export type ApiKeyResult = { ok: true } | { ok: false; error: string };

if (!process.contextIsolated) {
  throw new Error('Context isolation must be enabled in the BrowserWindow webPreferences.');
}

/** The typed surface the renderer sees as `window.pluck`. Keep narrow — every
 * new field is a new IPC handler in main/ipc.ts plus a new channel constant. */
const api = {
  startDownload: (request: DownloadRequest): Promise<{ id: string }> =>
    ipcRenderer.invoke(IpcChannels.StartDownload, request),

  /** Subscribe to push updates for any download. Returns an unsubscribe
   * function that removes only this listener — important to call from
   * useEffect cleanup so renderer reloads don't leak listeners. */
  onDownloadUpdate: (callback: (download: Download) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, download: Download): void => {
      callback(download);
    };
    ipcRenderer.on(IpcChannels.DownloadUpdate, listener);
    return (): void => {
      ipcRenderer.removeListener(IpcChannels.DownloadUpdate, listener);
    };
  },

  /** Open Finder showing the enclosing folder of `filePath`, with the file
   * selected. Fire and forget — main process handles the open. */
  showInFinder: (filePath: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.ShowInFinder, filePath),

  /** Open an http/https URL in the user's default browser. Main process
   * rejects non-http(s) schemes for safety. */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IpcChannels.OpenExternal, url),

  /** Speculative cache warmer. The UrlInput debounces typing and calls this
   * so the eventual Download click can skip the 2-4 s yt-dlp cold-start
   * metadata fetch. Fire-and-forget; main process never rejects. */
  prefetchMetadata: (url: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.PrefetchMetadata, url),

  /** Cancel an active download by id. Main aborts the yt-dlp child; the
   * row transitions to 'cancelled' status via the existing DownloadUpdate
   * channel. No-op if the id isn't currently downloading (e.g. it just
   * finished). */
  cancelDownload: (id: string): Promise<void> => ipcRenderer.invoke(IpcChannels.CancelDownload, id),

  /** Seed the renderer store on mount with everything main currently
   * knows about — persisted history plus any rows that are still
   * in-flight. Without this the renderer would miss updates emitted
   * before its DownloadUpdate listener attached. */
  getInitialState: (): Promise<Download[]> => ipcRenderer.invoke(IpcChannels.GetInitialState),

  /** Current persisted settings (output folder, etc.). Called once on
   * mount to populate the picker; refreshed after any update. */
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IpcChannels.GetSettings),

  /** Merge-patch settings. Today only `outputFolder` is writable; main
   * defensively ignores other keys. Returns the post-update snapshot. */
  updateSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IpcChannels.UpdateSettings, patch),

  /** Opens the native folder picker (sheet-anchored on macOS). On accept,
   * persists the choice and resolves with the path. Resolves undefined
   * if the user cancelled — settings untouched. */
  chooseOutputFolder: (): Promise<string | undefined> =>
    ipcRenderer.invoke(IpcChannels.ChooseOutputFolder),

  /** Re-enqueue a failed / cancelled row with its original URL + format.
   * Creates a new row (fresh id, fresh createdAt); the original stays
   * in history. Resolves { id: undefined } if the source id is unknown. */
  retryDownload: (id: string): Promise<{ id: string | undefined }> =>
    ipcRenderer.invoke(IpcChannels.RetryDownload, id),

  /** Deliver a password for a row that's waiting in 'needs_password'.
   * Main re-runs the download with the password as `--video-password`.
   * Empty passwords are silently ignored (no attempt is consumed). */
  submitPassword: (id: string, password: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.SubmitPassword, id, password),

  /** Which API keys are currently saved. Used to gate the Welcome
   * screen on boot and to disable features whose key is missing. */
  hasApiKeys: (): Promise<HasApiKeys> => ipcRenderer.invoke(IpcChannels.HasApiKeys),

  /** Validate a key against the provider's cheapest endpoint without
   * saving it. Returns { ok } on success or { ok: false, error } with
   * a user-facing message. */
  testApiKey: (name: SecretName, key: string): Promise<ApiKeyResult> =>
    ipcRenderer.invoke(IpcChannels.TestApiKey, name, key),

  /** Encrypt and persist a key. Fails (returns ok: false) only if the
   * OS keychain isn't available or disk write breaks. */
  saveApiKey: (name: SecretName, key: string): Promise<ApiKeyResult> =>
    ipcRenderer.invoke(IpcChannels.SaveApiKey, name, key),

  /** Drop a single key (pass `name`) or all keys (pass undefined). The
   * "delete all" form is used by the Settings panel's reset-to-first-
   * launch flow. */
  deleteApiKey: (name?: SecretName): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.DeleteApiKey, name),

  /** App version from package.json, for the Settings panel footer. */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannels.GetAppVersion),

  /** Subset of BROWSER_NAMES whose cookies file (or Firefox profile
   * dir) exists on disk. Used by the Settings dropdown to hide
   * browsers the user has never launched. */
  detectInstalledBrowsers: (): Promise<BrowserName[]> =>
    ipcRenderer.invoke(IpcChannels.DetectInstalledBrowsers),

  /** Subscribe to debug log events from main. Only fires when
   * settings.debugMode is true. Returns an unsubscribe function for
   * useEffect cleanup. */
  onDebugLog: (callback: (event: DebugLogEvent) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, payload: DebugLogEvent): void => {
      callback(payload);
    };
    ipcRenderer.on(IpcChannels.DebugLog, listener);
    return (): void => {
      ipcRenderer.removeListener(IpcChannels.DebugLog, listener);
    };
  },

  /** Open this download's temp folder in Finder. Returns
   * { ok: false, error } when the folder has been cleaned (typical
   * post-success case) — renderer surfaces the error in the log box. */
  openTempFolder: (id: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IpcChannels.OpenTempFolder, id),

  /** Wipe every per-download subfolder under the temp base. Returns
   * the count cleared. Used by the Settings "Clear debug temp folders"
   * button. */
  clearTempFolders: (): Promise<{ cleared: number }> =>
    ipcRenderer.invoke(IpcChannels.ClearTempFolders),
};

export type PluckAPI = typeof api;

try {
  contextBridge.exposeInMainWorld('pluck', api);
} catch (error) {
  console.error(error);
}
