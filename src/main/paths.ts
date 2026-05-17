import { join } from 'node:path';
import { app } from 'electron';

export const BUNDLED_BINARIES = ['yt-dlp', 'ffmpeg'] as const;
export type BundledBinary = (typeof BUNDLED_BINARIES)[number];

/**
 * Resolve the absolute path to a bundled CLI binary in both dev and packaged builds.
 *
 * In dev, binaries live under <repo>/resources/binaries/. In a packaged .app,
 * electron-builder's `extraResources` copies them to Contents/Resources/binaries/,
 * reachable via process.resourcesPath.
 */
export const binPath = (name: BundledBinary): string => {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'binaries', name);
  }
  return join(app.getAppPath(), 'resources', 'binaries', name);
};
