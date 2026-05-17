import { promises as fs, constants as fsConstants } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Filesystem staging helpers used by the IPC download handler. Pure of
 * Electron so the same flow can run from `scripts/test-runner.ts` against
 * `os.tmpdir()` and from the IPC handler against `~/Library/Caches/
 * video.pluck.app/`. Caller picks the base path.
 */

/** Per-download workspace at `<base>/<downloadId>/`. yt-dlp writes fragments
 * and the merged output here; we atomically move the final file to the user's
 * output folder once it's done. Caller chooses the base — see ipc.ts for the
 * production path (`~/Library/Caches/video.pluck.app/`) and test-runner.ts
 * for the smoke-harness path (under `os.tmpdir()`). */
export const createTempFolder = async (base: string, downloadId: string): Promise<string> => {
  const dir = join(base, downloadId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

/** Remove a temp folder and everything inside it. Idempotent — safe to call
 * from a `finally` even if the folder was already removed by a previous
 * cleanup attempt or never existed. */
export const removeTempFolder = async (dir: string): Promise<void> => {
  await fs.rm(dir, { recursive: true, force: true });
};

/**
 * Find a non-colliding path for `desiredBasename` inside `targetFolder`.
 * Returns the unchanged path if nothing's there; otherwise appends ` (2)`,
 * ` (3)`, ... before the extension — matching macOS Finder convention.
 *
 * Race condition note: between this lookup and the subsequent move,
 * another process could create the same file. For Pluck's single-user
 * desktop use case that's vanishingly rare; not worth a full open-with-
 * O_EXCL dance.
 */
export const resolveAvailablePath = async (
  targetFolder: string,
  desiredBasename: string,
): Promise<string> => {
  const ext = extname(desiredBasename);
  const stem = ext.length > 0 ? desiredBasename.slice(0, -ext.length) : desiredBasename;

  let candidate = join(targetFolder, desiredBasename);
  let suffix = 2;
  while (await pathExists(candidate)) {
    candidate = join(targetFolder, `${stem} (${suffix})${ext}`);
    suffix++;
  }
  return candidate;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Move a file from src to dst. Same-volume → atomic `fs.rename` (one B-tree
 * transaction on APFS, instant, no double-write). Cross-volume → `EXDEV`
 * forces a `copyFile + rm` fallback that's not atomic but is unavoidable
 * because POSIX `rename(2)` can't cross filesystem boundaries.
 *
 * For Pluck's default setup (~/Library/Caches/video.pluck.app/<id>/ →
 * ~/Downloads/Pluck/) both paths live on the same APFS container, so we
 * only ever hit the EXDEV branch if the user picks an output folder on an
 * external drive.
 *
 * If the copyFile succeeds but the post-copy rm fails (e.g. temp dir was
 * already unmounted), the move is still logically complete — the file is
 * at the destination. The leftover src will be reaped by the caller's
 * removeTempFolder() in its `finally`, so we swallow the rm error.
 */
export const moveFile = async (src: string, dst: string): Promise<void> => {
  try {
    await fs.rename(src, dst);
    return;
  } catch (err) {
    if (!isExdev(err)) {
      throw err;
    }
  }
  await fs.copyFile(src, dst);
  try {
    await fs.rm(src);
  } catch {
    // Intentionally swallowed — see docstring.
  }
};

const isExdev = (err: unknown): err is NodeJS.ErrnoException =>
  typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EXDEV';
