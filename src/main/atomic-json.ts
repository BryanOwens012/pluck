import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/** Write `data` to `filePath` atomically: serialize → write to a sibling
 * `.tmp` → `rename`. The rename is atomic on a single APFS / ext4 volume,
 * so a crash or power loss can't leave a half-written file at `filePath`.
 *
 * Used by history.ts, settings.ts, and secrets.ts — all three keep small
 * single-JSON-object state under `app.getPath('userData')`. The naming
 * convention (`<filename>.tmp`) is the same across callers so cleanup
 * scripts or crash-recovery checks can find them generically. */
export const atomicWriteJson = async (filePath: string, data: unknown): Promise<void> => {
  const tmpPath = `${filePath}.tmp`;
  await fs.mkdir(dirname(filePath), { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
};
