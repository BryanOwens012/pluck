import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, shell } from 'electron';
import icon from '../../resources/icon.png?asset';
import { IpcChannels } from '../shared/ipc-channels';
import type { Download } from '../shared/types';
import { createHistoryStore } from './history';
import { generateDownloadId, registerIpcHandlers } from './ipc';
import { createMetadataCache } from './metadata-cache';
import { binPath } from './paths';
import { createDownloadQueue } from './queue';
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

/** Default user-visible output folder. Per-request `outputFolder` overrides
 * this; PR 6 will add a settings-driven path. */
const DEFAULT_OUTPUT_FOLDER = join(homedir(), 'Downloads', 'Pluck');

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

  // Persisted history lives under app.getPath('userData') — Electron's
  // per-user, per-app config dir. Survives reinstalls (until the user
  // explicitly nukes Application Support).
  const history = createHistoryStore(app.getPath('userData'));
  const persistedDownloads = await history.load();

  const runnerDeps = { ytDlpPath: binPath('yt-dlp'), ffmpegPath: binPath('ffmpeg') };
  const metadataCache = createMetadataCache((url) => fetchMetadata(url, runnerDeps));

  const queue = createDownloadQueue({
    defaultOutputFolder: DEFAULT_OUTPUT_FOLDER,
    tempBaseDir: PLUCK_CACHE_DIR,
    runnerDeps,
    runDownload,
    metadataCache,
    generateId: generateDownloadId,
    onUpdate: broadcastDownloadUpdate,
    onTerminalChange: (downloads) => {
      // Fire-and-forget. A write failure logs but doesn't crash the app
      // — the user's downloads still completed; history is best-effort.
      history.save(downloads).catch((err: unknown) => {
        console.error('history: save failed', err);
      });
    },
  });

  // Seed the queue with persisted rows so the renderer's GetInitialState
  // call returns them. history.load already rewrote any 'downloading' /
  // 'queued' from the prior session to 'failed' (interrupted).
  queue.rehydrate(persistedDownloads);

  registerIpcHandlers({ queue, metadataCache });
  prewarmYtDlp();
  createWindow();

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
