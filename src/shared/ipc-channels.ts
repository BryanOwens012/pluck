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
  /** Main -> renderer, send. Lifecycle phase events + raw yt-dlp
   * stderr lines, emitted only when debugMode is on. Renderer
   * appends to per-id log buffers. */
  DebugLog: 'pluck:debug-log',
  /** Renderer -> main, invoke. Opens the per-download temp folder in
   * Finder (debug-mode affordance — lets the user inspect yt-dlp's
   * in-flight fragments + merged output). No-op if the folder has
   * already been cleaned (typical post-success case). */
  OpenTempFolder: 'pluck:open-temp-folder',
  /** Renderer -> main, invoke. Walks the per-app cache dir and
   * removes every per-download subfolder under it — skipping any
   * folder whose id matches an active (downloading / canceling) row.
   * Returns { cleared, skippedActive } so the Settings button can
   * tell the user "Cleared N folders" plus "Skipped K active". */
  ClearTempFolders: 'pluck:clear-temp-folders',
  /** Renderer -> main, invoke. Returns FormatChoice[] for the given
   * URL — the four static presets with per-URL labels enriched (real
   * dimensions, fps, container) plus an optional 5th non-mp4 option
   * when it strictly beats the best mp4. Falls back to the four
   * static defaults if metadata isn't available. */
  GetFormatChoices: 'pluck:get-format-choices',
  /** Renderer -> main, invoke. Returns whether a file currently
   * exists at the given absolute path. Used by completed download
   * rows to detect when the user moved / trashed the file out of
   * band, so we can gray out the "Reveal in Finder" button instead
   * of opening Finder on a stale path. */
  FileExists: 'pluck:file-exists',
  /** Renderer -> main, invoke. Returns the yt-dlp command string
   * that would be spawned right now given the current settings,
   * formatted shell-safe for display. The `url` argument is optional;
   * when omitted, the returned string has a `<URL>` placeholder where
   * the URL would land. Powers the "yt-dlp command" preview in the
   * Settings developer pane. */
  GetInvocationPreview: 'pluck:get-invocation-preview',
  /** Renderer -> main, invoke. Tokenizes a yt-dlp override string and
   * returns either the parsed argv plus the known-flag extractions
   * (`-N`, `--cookies-from-browser`, `-f`, `-o`), or a parse error.
   * The Settings panel calls this when the override text changes to
   * decide which dependent controls to gray out and what values to
   * surface as informational. */
  ParseYtDlpCommand: 'pluck:parse-yt-dlp-command',
  /** Renderer -> main, invoke. Runs `yt-dlp -J --yes-playlist
   * --flat-playlist <url>` to expand a playlist URL into its
   * constituent video entries. Returns the entry list + the parent
   * playlist's id/title/count. The renderer uses this AFTER the user
   * picks "All videos" in the PlaylistPrompt modal — never on paste,
   * to avoid surprising network cost. */
  EnumeratePlaylist: 'pluck:enumerate-playlist',
  /** Renderer -> main, invoke. Enqueues a playlist of N entries as N
   * separate Download rows. Each row inherits the chosen FormatChoice
   * and gets `playlistId` / `playlistTitle` / `playlistIndex` /
   * `playlistTotal` set so the renderer can group them under a
   * playlist header. Returns the list of new download ids in enqueue
   * order so the caller can correlate UI state. */
  StartPlaylistDownload: 'pluck:start-playlist-download',
  /** Renderer -> main, invoke. Kick off the transcription pipeline
   * for a completed download row. Main pulls the row's `filePath`,
   * extracts audio, uploads to ElevenLabs, writes a `.srt` next to
   * the video, and emits progress via the existing DownloadUpdate
   * channel (each step patches the row's `transcriptionStatus`).
   * Returns immediately with `{ ok }` — the actual work is async +
   * monitored via the DownloadUpdate stream. */
  TranscribeDownload: 'pluck:transcribe-download',
  /** Renderer -> main, invoke. Returns the currently-installed
   * yt-dlp version + which copy is in use (bundled vs. auto-
   * updated). Cheap (runs `yt-dlp --version` + an fs.access);
   * called by the Developer accordion on open. */
  GetYtDlpStatus: 'pluck:get-yt-dlp-status',
  /** Renderer -> main, invoke. Hit GitHub's releases API to learn
   * the latest available yt-dlp version. Returns the installed
   * version + latest + a derived `updateAvailable` flag. Failure
   * (network down, GitHub 5xx) surfaces as `error` in the result
   * so the UI can render a "couldn't check" message rather than
   * pretending we're up to date. */
  CheckYtDlpUpdate: 'pluck:check-yt-dlp-update',
  /** Renderer -> main, invoke. Download the latest yt-dlp into the
   * user-data dir. The install completes before the IPC resolves;
   * the current session keeps using its already-spawned binary
   * (the new copy takes effect on next app launch). */
  InstallYtDlpUpdate: 'pluck:install-yt-dlp-update',
  /** Renderer -> main, invoke. Cancels every active download and
   * wipes the library (in-memory queue + persisted history.json).
   * Already-downloaded files on disk are NOT deleted — this only
   * clears Pluck's view of the library. */
  ClearLibrary: 'pluck:clear-library',
  /** Main -> renderer, send. Broadcast after a ClearLibrary call so
   * every renderer view drops its mirrored downloads Map. Fired
   * unconditionally on clear (even if the library was already empty)
   * so the renderer's wipe is idempotent. */
  LibraryCleared: 'pluck:library-cleared',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
