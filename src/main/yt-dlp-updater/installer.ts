import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { getUserDataYtDlpPath } from './paths';

/** Download a fresh yt-dlp binary to `<userData>/binaries/yt-dlp`.
 * Uses a `.tmp` neighbor + rename so a partial write (network
 * drop, process crash) can't leave a corrupt binary in the live
 * path. chmod +x runs before the rename so the binary is
 * executable the instant the rename atomically reveals it.
 *
 * The userData binary lives OUTSIDE the signed `.app` bundle, so
 * macOS doesn't reject the modification the way it would refuse to
 * overwrite the bundled copy via `yt-dlp -U`.
 *
 * The macOS yt-dlp build is ~30 MB; we buffer into memory rather
 * than streaming. Simpler than the `Readable.fromWeb` adapter
 * dance, and 30 MB is well within Node's default heap. */
export const installLatestYtDlp = async (downloadUrl: string): Promise<string> => {
  const finalPath = getUserDataYtDlpPath();
  const tmpPath = `${finalPath}.tmp`;
  await fs.mkdir(dirname(finalPath), { recursive: true });

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await fs.writeFile(tmpPath, bytes);
  // chmod BEFORE rename so the file is executable the instant it
  // becomes visible at the final path. Otherwise a concurrent
  // spawn could pick up the file mid-mode-change and hit EACCES.
  await fs.chmod(tmpPath, 0o755);
  await fs.rename(tmpPath, finalPath);
  return finalPath;
};
