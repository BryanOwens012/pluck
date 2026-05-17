import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Schema version. Bump on any breaking change to the on-disk shape so we
 * can migrate or discard cleanly. Currently v1 — initial schema. */
const SCHEMA_VERSION = 1;

const SETTINGS_FILENAME = 'settings.json';

/** Spec default — `~/Downloads/Pluck/` is created lazily by the queue on
 * first download via `fs.mkdir({ recursive: true })`, so the folder doesn't
 * need to exist at settings-load time. */
export const defaultOutputFolder = (): string => join(homedir(), 'Downloads', 'Pluck');

export type Settings = {
  outputFolder: string;
};

type SettingsFile = {
  version: number;
  settings: Settings;
};

export type SettingsStore = {
  /** Returns the in-memory snapshot. Synchronous so the queue can read
   * the current outputFolder per enqueue without await-juggling. */
  get(): Settings;
  /** Merge-update on disk. Caller passes only the keys they want to
   * change; existing values are preserved. */
  update(patch: Partial<Settings>): Promise<Settings>;
};

const isSettingsFile = (value: unknown): value is SettingsFile => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== SCHEMA_VERSION) {
    return false;
  }
  const s = obj.settings;
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof (s as Record<string, unknown>).outputFolder === 'string'
  );
};

/** File-backed settings. `dir` is typically `app.getPath('userData')`;
 * passed in (not imported) so the module is testable outside Electron.
 * Loads at construction so `get()` is synchronous afterward. */
export const createSettingsStore = async (dir: string): Promise<SettingsStore> => {
  const filePath = join(dir, SETTINGS_FILENAME);
  const tmpPath = `${filePath}.tmp`;

  let current: Settings = { outputFolder: defaultOutputFolder() };

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isSettingsFile(parsed)) {
      current = parsed.settings;
    } else {
      console.error('settings: schema mismatch, using defaults');
    }
  } catch (err) {
    // ENOENT is the first-run case — silent. Any other read or parse
    // failure logs once and falls back to defaults so the app boots.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('settings: failed to read, using defaults', err);
    }
  }

  const writeAtomic = async (next: Settings): Promise<void> => {
    const body: SettingsFile = { version: SCHEMA_VERSION, settings: next };
    await fs.mkdir(dirname(filePath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(body, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  };

  const get = (): Settings => current;

  const update = async (patch: Partial<Settings>): Promise<Settings> => {
    const next = { ...current, ...patch };
    await writeAtomic(next);
    // Commit to memory only after the rename succeeds — a failed write
    // shouldn't leave the in-memory snapshot ahead of disk.
    current = next;
    return next;
  };

  return { get, update };
};
