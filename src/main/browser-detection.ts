import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_NAMES, type BrowserName } from '../shared/types';

/** macOS paths to probe per browser. The signal isn't "is the app
 * installed" — it's "does the cookies store exist on disk", which is
 * what yt-dlp actually needs. A browser that's installed but never
 * launched has no cookies; showing it in the dropdown would mislead.
 *
 * Chrome / Brave / Edge: per-Chromium-profile `Cookies` SQLite file
 * under the "Default" profile (Chromium's primary profile name).
 *
 * Firefox: profile directories have random prefixes (`abc.default-release`)
 * so we just check that the Profiles parent dir exists. yt-dlp's
 * `--cookies-from-browser firefox` does its own profile picking.
 *
 * Safari: single cookies file under `~/Library/Cookies/`. Note that this
 * file ships pre-created on every macOS install, so Safari will almost
 * always show up as "detected" even for users who don't actually use
 * it — fine for the dropdown, just don't auto-pick it. */
export const BROWSER_PROBE_PATHS: Record<BrowserName, string> = {
  chrome: join(homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies'),
  firefox: join(homedir(), 'Library/Application Support/Firefox/Profiles'),
  safari: join(homedir(), 'Library/Cookies/Cookies.binarycookies'),
  brave: join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies'),
  edge: join(homedir(), 'Library/Application Support/Microsoft Edge/Default/Cookies'),
};

/** Function shape for the probe. Default impl uses `fs.stat` on the real
 * filesystem; tests inject a fake to assert behaviour deterministically
 * without depending on whatever browsers happen to be installed on the
 * dev machine. */
export type ExistsProbe = (path: string) => Promise<boolean>;

const defaultExists: ExistsProbe = async (path) => {
  try {
    await fs.stat(path);
    return true;
  } catch {
    // ENOENT or any other error → treat as "not installed". We don't
    // try to distinguish ENOENT from EACCES because both produce the
    // same correct dropdown behaviour: hide the browser.
    return false;
  }
};

/** Returns the subset of `BROWSER_NAMES` whose probe path exists on the
 * filesystem, preserving the BROWSER_NAMES display order. Cached at the
 * call site — the renderer fires this once when Settings opens. */
export const detectInstalledBrowsers = async (
  exists: ExistsProbe = defaultExists,
): Promise<BrowserName[]> => {
  const results = await Promise.all(
    BROWSER_NAMES.map(async (name) => ({ name, ok: await exists(BROWSER_PROBE_PATHS[name]) })),
  );
  return results.filter((r) => r.ok).map((r) => r.name);
};
