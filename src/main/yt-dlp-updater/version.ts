import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import { getBundledYtDlpPath, getUserDataYtDlpPath } from './paths';

const execFileAsync = promisify(execFile);

/** Which copy of yt-dlp is currently in use — drives the
 * Settings UI's "(bundled)" / "(auto-updated)" label. */
export const YT_DLP_SOURCES = ['bundled', 'auto-updated'] as const;
export type YtDlpSource = (typeof YT_DLP_SOURCES)[number];

export type YtDlpInstallation = {
  /** The version string from `yt-dlp --version` (yt-dlp emits a
   * single line like `2026.03.17`). Undefined if the binary is
   * missing or the version probe failed — caller can render "—". */
  version: string | undefined;
  /** Which path produced this version. */
  source: YtDlpSource;
  /** Absolute path. Exposed for diagnostics + the queue's
   * `runnerDeps.ytDlpPath`. */
  path: string;
};

/** Cheap path-only resolution — no spawn. Prefers the
 * auto-updater's userData copy when it exists (newer); falls back
 * to the bundled binary on first run / when the userData copy was
 * deleted. Used at startup where blocking on `yt-dlp --version`
 * would delay window creation (PyInstaller unpack + macOS
 * Gatekeeper code-signature check on first launch can run into
 * multiple seconds). */
export const resolveYtDlpPath = async (): Promise<Pick<YtDlpInstallation, 'path' | 'source'>> => {
  const userDataPath = getUserDataYtDlpPath();
  const bundledPath = getBundledYtDlpPath();
  const userDataExists = await fileExists(userDataPath);
  return {
    path: userDataExists ? userDataPath : bundledPath,
    source: userDataExists ? 'auto-updated' : 'bundled',
  };
};

/** Resolve the yt-dlp path the app should currently use + read its
 * version. Used by the Settings panel and the update checker —
 * NOT on the startup hot path; see `resolveYtDlpPath` for that. */
export const readCurrentYtDlpInstallation = async (): Promise<YtDlpInstallation> => {
  const { path, source } = await resolveYtDlpPath();
  const version = await readYtDlpVersion(path);
  return { version, source, path };
};

/** Run `yt-dlp --version` and return the trimmed output. Returns
 * undefined on any failure (binary missing, not-executable,
 * unexpected exit) so callers can render "—" or "unknown" rather
 * than crashing the Settings panel. */
const readYtDlpVersion = async (path: string): Promise<string | undefined> => {
  try {
    const { stdout } = await execFileAsync(path, ['--version']);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};
