import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, shell } from 'electron';
import icon from '../../resources/icon.png?asset';
import { registerIpcHandlers } from './ipc';
import { binPath } from './paths';

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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('video.pluck.app');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerIpcHandlers();
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
