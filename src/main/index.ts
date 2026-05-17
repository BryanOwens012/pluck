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

/** Spawn `yt-dlp --version` in the background so PyInstaller unpacks the
 * bundled Python runtime + extractors ahead of the user's first real
 * invocation. Saves roughly 200 ms on the cold-path metadata fetch. Pure
 * local work — no network, no privacy leak. Errors are intentionally
 * swallowed; if it fails the real download will surface the same problem. */
const prewarmYtDlp = (): void => {
  execFile(binPath('yt-dlp'), ['--version'], () => {
    // Intentionally empty — fire and forget.
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
