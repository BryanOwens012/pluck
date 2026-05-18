/**
 * Single source of truth for IPC channel names. Both the main process
 * (ipcMain.handle / webContents.send) and the preload bridge (ipcRenderer.invoke
 * / on) import from here, so a typo breaks at compile time instead of silently
 * dropping messages.
 */

export const IpcChannels = {
  /** Renderer -> main, invoke. Starts a single download. Returns the new id. */
  StartDownload: 'pluck:start-download',
  /** Main -> renderer, send. Pushes the latest Download state for any id. */
  DownloadUpdate: 'pluck:download-update',
  /** Renderer -> main, invoke. Opens Finder showing the parent folder of the
   * given file with the file selected. macOS "Reveal in Finder" semantics. */
  ShowInFinder: 'pluck:show-in-finder',
  /** Renderer -> main, invoke. Opens an https URL in the user's default
   * browser via shell.openExternal. Used by the source-site icon. */
  OpenExternal: 'pluck:open-external',
  /** Renderer -> main, invoke. Speculative warm of the metadata cache;
   * fire-and-forget. The UrlInput debounces and calls this so a subsequent
   * Download click can skip the 2-4 s yt-dlp cold-start fetch. */
  PrefetchMetadata: 'pluck:prefetch-metadata',
  /** Renderer -> main, invoke. Cancels an active download by id. Main
   * aborts the in-flight yt-dlp process; the download's status flips to
   * 'cancelled' (not 'failed') via the existing DownloadUpdate channel. */
  CancelDownload: 'pluck:cancel-download',
  /** Renderer -> main, invoke. Returns the current full snapshot (history
   * + any live in-flight rows) so the renderer can seed its store on
   * mount without missing updates emitted before the listener attached. */
  GetInitialState: 'pluck:get-initial-state',
  /** Renderer -> main, invoke. Returns the current persisted settings
   * (output folder, etc.). Synchronous to the renderer since main holds
   * an in-memory snapshot. */
  GetSettings: 'pluck:get-settings',
  /** Renderer -> main, invoke. Merge-update settings on disk. Returns
   * the post-update snapshot so the renderer can refresh its UI. */
  UpdateSettings: 'pluck:update-settings',
  /** Renderer -> main, invoke. Opens the native folder picker. On accept,
   * also persists the choice via UpdateSettings and returns the new path;
   * on cancel, returns undefined and settings are untouched. */
  ChooseOutputFolder: 'pluck:choose-output-folder',
  /** Renderer -> main, invoke. Re-enqueues a failed/cancelled row with
   * its original URL + format, creating a new Download row (fresh id,
   * fresh createdAt). The original row stays in history as-is. */
  RetryDownload: 'pluck:retry-download',
  /** Renderer -> main, invoke. Deliver a password for a row that's
   * waiting in 'needs_password'. Main re-runs the download with the
   * password as `--video-password`. After MAX_PASSWORD_ATTEMPTS wrong
   * submissions the row terminates as 'failed'. */
  SubmitPassword: 'pluck:submit-password',
  /** Renderer -> main, invoke. Returns { anthropic: boolean,
   * elevenlabs: boolean } so the renderer can decide which features
   * are enabled and whether Welcome should appear on boot. */
  HasApiKeys: 'pluck:has-api-keys',
  /** Renderer -> main, invoke. Validate a key against the provider's
   * cheapest endpoint without saving it. Returns { ok } or
   * { ok: false, error }. */
  TestApiKey: 'pluck:test-api-key',
  /** Renderer -> main, invoke. Encrypt and persist a key. Throws if
   * the OS keychain is unavailable. */
  SaveApiKey: 'pluck:save-api-key',
  /** Renderer -> main, invoke. Drop one or all keys (Settings panel
   * uses the all form to reset to first-launch state). */
  DeleteApiKey: 'pluck:delete-api-key',
  /** Renderer -> main, invoke. Returns the app's package.json version
   * so the Settings panel can show "Pluck 0.1.0" at the bottom. */
  GetAppVersion: 'pluck:get-app-version',
  /** Renderer -> main, invoke. Returns the subset of BROWSER_NAMES
   * whose cookies file (or profile dir, for Firefox) exists on disk.
   * Settings dropdown uses this to hide browsers the user has never
   * launched on this Mac. */
  DetectInstalledBrowsers: 'pluck:detect-installed-browsers',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
