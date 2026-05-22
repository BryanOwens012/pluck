import { fetchLatestRelease } from './github';
import { installLatestYtDlp } from './installer';
import { readCurrentYtDlpInstallation, type YtDlpInstallation } from './version';

/** Outcome of `checkForUpdate()` — fed into the Settings UI. */
export type UpdateCheckResult = {
  /** Current installed version + which copy it came from. */
  current: YtDlpInstallation;
  /** Latest available version on GitHub. Undefined when the
   * check itself failed (network down, GitHub 5xx, etc.). */
  latestVersion: string | undefined;
  /** True iff `latestVersion` is set AND differs from the
   * installed version. yt-dlp uses calendar versioning
   * (`YYYY.MM.DD`) which sorts lexically, so a string `!==` is
   * a "different version" check; ignoring the "newer-vs-older"
   * direction is intentional since the user almost always wants
   * to be on whatever GitHub calls "latest". */
  updateAvailable: boolean;
  /** When this check ran. Used by the UI to render "last
   * checked: 2m ago" without a separate timestamp store. */
  checkedAt: number;
  /** Failure message if the GitHub fetch failed — surfaces in
   * Settings so the user knows whether they're seeing a real
   * "up to date" or a silent network drop. */
  error?: string;
};

/** Outcome of `installUpdate()`. Decoupled from the check result
 * because installs are rare and the install path has its own
 * failure surface (download / disk write / chmod). */
export type InstallResult = { ok: true; installedPath: string } | { ok: false; error: string };

/** Hit GitHub, read the installed version, decide whether an
 * update is needed. Never throws — every failure path lands in
 * the result with an `error` string the UI can render. */
export const checkForUpdate = async (): Promise<UpdateCheckResult> => {
  const current = await readCurrentYtDlpInstallation();
  const checkedAt = Date.now();
  try {
    const latest = await fetchLatestRelease();
    return {
      current,
      latestVersion: latest.version,
      updateAvailable: current.version !== undefined && current.version !== latest.version,
      checkedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update check failed.';
    return {
      current,
      latestVersion: undefined,
      updateAvailable: false,
      checkedAt,
      error: message,
    };
  }
};

/** Download the latest yt-dlp + install atomically into
 * `<userData>/binaries/yt-dlp`. Re-fetches the release info so
 * the install always pulls from the freshest GitHub release URL
 * (download URLs in the GitHub Releases API are stable but
 * regenerating keeps the install path self-contained — caller
 * doesn't have to thread the URL through from an earlier
 * `checkForUpdate()`). */
export const installUpdate = async (): Promise<InstallResult> => {
  try {
    const latest = await fetchLatestRelease();
    const installedPath = await installLatestYtDlp(latest.downloadUrl);
    return { ok: true, installedPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update install failed.';
    return { ok: false, error: message };
  }
};
