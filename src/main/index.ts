import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, safeStorage, shell } from 'electron';
import icon from '../../resources/icon.png?asset';
import { IpcChannels } from '../shared/ipc-channels';
import type { Download } from '../shared/types';
import { createPlaylistEnumerator } from './downloader/playlist/enumerator';
import { createDownloadQueue } from './downloader/queue';
import { createHistoryStore } from './history';
import { generateDownloadId, registerIpcHandlers } from './ipc';
import { createMetadataCache } from './metadata-cache';
import { binPath } from './paths';
import { createSecretsStore, type Encryptor } from './secrets';
import { createSettingsStore } from './settings';
import { checkForUpdate, installUpdate } from './yt-dlp-updater/updater';
import { readCurrentYtDlpInstallation } from './yt-dlp-updater/version';
import { fetchMetadata, runDownload } from './ytdlp/runner';

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 700,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (is.dev && rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

// "Me at the zoo" — the first video ever uploaded to YouTube (2005), 19s,
// guaranteed available, billions of views. Used to warm yt-dlp's player-JS
// cache so the user's first real YouTube download skips the slow
// JS-challenge step. Indistinguishable in YouTube's logs from anyone
// opening this URL in a browser.
const PREWARM_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

/** Two prewarm spawns at app launch:
 *
 * 1. `yt-dlp --version` — PyInstaller unpacks the bundled Python runtime
 *    + extractors. Saves ~200 ms of process-startup overhead on the cold
 *    metadata fetch. Pure local work.
 * 2. `yt-dlp -J --no-download <Me at the zoo>` — populates yt-dlp's
 *    per-player-version JS cache. Skips the ~1-2 s deno-based signature
 *    deobfuscation step on every subsequent YouTube download for the next
 *    ~24 h (yt-dlp's cache TTL). ~50 KB outbound; one page-view to a
 *    public URL with no user identity attached.
 *
 * Both fire and forget — errors swallowed because the real download would
 * surface the same problem. */
const prewarmYtDlp = (): void => {
  execFile(binPath('yt-dlp'), ['--version'], () => {
    // Intentionally empty.
  });
  execFile(binPath('yt-dlp'), ['-J', '--no-download', PREWARM_URL], () => {
    // Intentionally empty.
  });
};

/** Per-download workspaces live under `~/Library/Caches/video.pluck.app/`.
 * Same APFS volume as ~/Downloads so the move-out is an atomic rename;
 * predictable path (vs Electron's randomized temp dir); macOS may purge it
 * under "Optimize Storage" pressure — free hygiene on top of our own
 * try/finally cleanup. Stable across dev and packaged builds. */
const PLUCK_CACHE_DIR = join(homedir(), 'Library', 'Caches', 'video.pluck.app');

/** Fan a queue update out to every live window. Multiple BrowserWindows
 * aren't created today, but the broadcast is the cheap correct default —
 * isolating to "the originating window" would be wrong if the user opens
 * a second window later. */
const broadcastDownloadUpdate = (download: Download): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IpcChannels.DownloadUpdate, download);
    }
  }
};

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('video.pluck.app');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Persisted state lives under app.getPath('userData') — Electron's
  // per-user, per-app config dir. Survives reinstalls (until the user
  // explicitly nukes Application Support). Settings, history, and
  // secrets share the directory but live in separate files (all written
  // via atomic-json so partial writes can't leave half-baked state).
  const userDataDir = app.getPath('userData');
  const settings = await createSettingsStore(userDataDir);
  // Electron's safeStorage adapter for the secrets store. The wrapper
  // shape lets tests inject a fake without booting an Electron context
  // (safeStorage requires app.whenReady, which the test harness lacks).
  //
  // IMPORTANT: every safeStorage call MUST happen after app.whenReady().
  // Calling earlier locks the Keychain service name to "Chromium Safe
  // Storage" — a bucket shared with every other Electron app on the
  // machine — instead of the per-app "video.pluck.app Safe Storage"
  // entry we want. See electron/electron#48206. The construction of
  // this adapter (and the createSecretsStore call below) sits inside
  // the whenReady callback specifically for this reason.
  const encryptor: Encryptor = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
  };
  const secrets = await createSecretsStore(userDataDir, encryptor);
  const history = createHistoryStore(userDataDir);
  const persistedDownloads = await history.load();

  // Resolve which yt-dlp copy to use BEFORE any spawn happens. The
  // userData copy (written by the auto-updater on previous launches)
  // takes precedence over the bundled binary; first-run users fall
  // through to bundled. The path is captured into runnerDeps and
  // reused for every spawn this session — a freshly-downloaded
  // update during THIS session takes effect on the next launch.
  const ytDlpInstallation = await readCurrentYtDlpInstallation();
  const runnerDeps = { ytDlpPath: ytDlpInstallation.path, ffmpegPath: binPath('ffmpeg') };
  // Live-read cookies from settings at fetch time so a change takes
  // effect on the next prefetch / metadata fetch without rebuilding
  // the cache. Already-cached entries stay (per the cache's no-TTL
  // design), but a failed fetch evicts itself so auth-required URLs
  // self-heal after the user picks a browser.
  const metadataCache = createMetadataCache((url) =>
    fetchMetadata(url, runnerDeps, { cookiesFromBrowser: settings.get().cookiesFromBrowser }),
  );

  // Fan a debug log event out to every live window. Same broadcast
  // pattern as broadcastDownloadUpdate — keeps multi-window safe.
  const broadcastDebugLog = (event: import('../shared/types').DebugLogEvent): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(IpcChannels.DebugLog, event);
      }
    }
  };

  const queue = createDownloadQueue({
    // Callable so a settings update takes effect on the next enqueue
    // without rebuilding the queue. In-flight rows keep the folder
    // snapshotted in their Download struct.
    getDefaultOutputFolder: () => settings.get().outputFolder,
    getCookiesFromBrowser: () => settings.get().cookiesFromBrowser,
    getConcurrentFragments: () => settings.get().concurrentFragments,
    getYtDlpCommandOverride: () => settings.get().ytDlpCommandOverride,
    getMaxConcurrentDownloads: () => settings.get().concurrentDownloads,
    getDebugMode: () => settings.get().debugMode,
    tempBaseDir: PLUCK_CACHE_DIR,
    runnerDeps,
    runDownload,
    metadataCache,
    generateId: generateDownloadId,
    onUpdate: broadcastDownloadUpdate,
    onDebugLog: broadcastDebugLog,
    onPersistChange: (downloads) => {
      // Fire-and-forget. A write failure logs but doesn't crash the app
      // — history is best-effort. Called on enqueue, every status
      // transition, and every terminal end (but NOT on in-status
      // progress patches — those would thrash the disk).
      history.save(downloads).catch((err: unknown) => {
        console.error('history: save failed', err);
      });
    },
  });

  // Seed the queue with persisted rows so the renderer's GetInitialState
  // call returns them. history.load already rewrote any 'downloading' /
  // 'queued' from the prior session to 'failed' (interrupted).
  queue.rehydrate(persistedDownloads);

  const enumeratePlaylist = createPlaylistEnumerator(runnerDeps, {
    getCookiesFromBrowser: () => settings.get().cookiesFromBrowser,
  });
  registerIpcHandlers({
    queue,
    metadataCache,
    settings,
    secrets,
    tempBaseDir: PLUCK_CACHE_DIR,
    enumeratePlaylist,
    ffmpegPath: runnerDeps.ffmpegPath,
  });
  prewarmYtDlp();
  createWindow();

  // Background auto-update for yt-dlp. yt-dlp ships roughly weekly
  // — a stale binary breaks on YouTube as the player JS evolves.
  // Runs after createWindow() so the user sees the UI before any
  // network call. Silent on success (the updated binary takes
  // effect on next launch); failures are logged but don't crash.
  // The Settings → Developer accordion surfaces the same info
  // (version, last check, update available) so the user can also
  // trigger checks / installs manually.
  if (settings.get().ytDlpAutoUpdate) {
    void (async () => {
      try {
        const result = await checkForUpdate();
        if (result.updateAvailable) {
          await installUpdate();
        }
      } catch (err) {
        // checkForUpdate / installUpdate both return error-shape
        // results rather than throwing, but defense in depth.
        console.error('yt-dlp auto-update failed', err);
      }
    })();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
