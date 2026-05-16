import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { electronApp, is, optimizer } from '@electron-toolkit/utils';
import { app, BrowserWindow, shell } from 'electron';
import icon from '../../resources/icon.png?asset';
import { type BundledBinary, binPath } from './paths';

const execFileAsync = promisify(execFile);

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

// Temporary startup probe — replaced by the real yt-dlp runner in PR 3.
// Verifies both bundled binaries are present and executable on every launch.
const probeBundledBinaries = async (): Promise<void> => {
  const probes: Array<{ name: BundledBinary; flag: string }> = [
    { name: 'yt-dlp', flag: '--version' },
    { name: 'ffmpeg', flag: '-version' },
  ];
  for (const { name, flag } of probes) {
    try {
      const { stdout } = await execFileAsync(binPath(name), [flag]);
      const firstLine = stdout.split('\n', 1)[0] ?? '';
      console.log(`[pluck] ${name} ok: ${firstLine}`);
    } catch (err) {
      console.error(`[pluck] ${name} probe failed:`, err);
    }
  }
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId('video.pluck.app');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  void probeBundledBinaries();
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
