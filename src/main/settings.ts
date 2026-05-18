import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_NAMES, type BrowserName } from '../shared/types';
import { atomicWriteJson } from './atomic-json';

// Re-export so existing main-process callers don't need to follow the
// types over to shared/. New callers can import either path.
export { BROWSER_NAMES, type BrowserName };

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
  /** When set, every yt-dlp invocation (metadata + download) gets
   * `--cookies-from-browser <name>`. Undefined = no cookies passed.
   * Unlocks age-gated YouTube, private Vimeo / LinkedIn / Twitter, and
   * other login-required content the user is already signed in to. */
  cookiesFromBrowser?: BrowserName;
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
  const s = obj.settings as Record<string, unknown> | null;
  if (typeof s !== 'object' || s === null) {
    return false;
  }
  // Only outputFolder is required. Future additive fields are merged
  // under defaults in createSettingsStore so a legacy file missing a
  // newer key reads cleanly rather than carrying `undefined` forward.
  if (typeof s.outputFolder !== 'string') {
    return false;
  }
  // cookiesFromBrowser is optional; if present, must be one of the
  // known browser names. Reject the file if it's something else — a
  // hand-edited typo or schema drift would otherwise silently pass an
  // invalid value through to yt-dlp.
  if (s.cookiesFromBrowser !== undefined) {
    if (typeof s.cookiesFromBrowser !== 'string') {
      return false;
    }
    if (!(BROWSER_NAMES as readonly string[]).includes(s.cookiesFromBrowser)) {
      return false;
    }
  }
  return true;
};

/** File-backed settings. `dir` is typically `app.getPath('userData')`;
 * passed in (not imported) so the module is testable outside Electron.
 * Loads at construction so `get()` is synchronous afterward. */
export const createSettingsStore = async (dir: string): Promise<SettingsStore> => {
  const filePath = join(dir, SETTINGS_FILENAME);

  const defaults: Settings = { outputFolder: defaultOutputFolder() };
  let current: Settings = defaults;

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (isSettingsFile(parsed)) {
      // Spread defaults under the persisted snapshot so any future
      // field added here gets a default rather than undefined when an
      // older file is loaded.
      current = { ...defaults, ...parsed.settings };
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

  const get = (): Settings => current;

  const update = async (patch: Partial<Settings>): Promise<Settings> => {
    const next = { ...current, ...patch };
    const body: SettingsFile = { version: SCHEMA_VERSION, settings: next };
    await atomicWriteJson(filePath, body);
    // Commit to memory only after the rename succeeds — a failed write
    // shouldn't leave the in-memory snapshot ahead of disk.
    current = next;
    return next;
  };

  return { get, update };
};
