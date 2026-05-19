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

/** yt-dlp `-N` value: parallel HTTP connections per single download.
 * 1 is fully serial; ~16 is where per-server rate limits start
 * tripping on YouTube / Vimeo / Zoom for most users, but yt-dlp
 * itself doesn't cap it. We expose up to 20 so a power user with a
 * fat pipe can push it if they want. Default 14 saturates most home
 * connections cleanly. */
export const MIN_CONCURRENT_FRAGMENTS = 1;
export const MAX_CONCURRENT_FRAGMENTS = 20;
export const DEFAULT_CONCURRENT_FRAGMENTS = 14;

/** Number of simultaneous downloads the queue allows. A 4th waits in
 * 'queued' until a slot opens. Lower keeps each row faster (no
 * bandwidth contention); higher gets more rows moving at once. 10 is
 * a soft ceiling — beyond that the queue chews bandwidth without
 * meaningfully improving wall time. Default 3 keeps it sane. */
export const MIN_CONCURRENT_DOWNLOADS = 1;
export const MAX_CONCURRENT_DOWNLOADS = 10;
export const DEFAULT_CONCURRENT_DOWNLOADS = 3;

export type Settings = {
  outputFolder: string;
  /** When set, every yt-dlp invocation (metadata + download) gets
   * `--cookies-from-browser <name>`. Undefined = no cookies passed.
   * Unlocks age-gated YouTube, private Vimeo / LinkedIn / Twitter, and
   * other login-required content the user is already signed in to. */
  cookiesFromBrowser?: BrowserName;
  /** Power-user diagnostic surface. When on: every download row gets
   * a live log box + folder button to its temp dir; the queue emits
   * lifecycle events to the renderer; the runner forwards raw stderr
   * lines; failed downloads keep their temp folder for inspection.
   * Default `false` — invisible to the primary user. */
  debugMode: boolean;
  /** Integer in [MIN_CONCURRENT_FRAGMENTS, MAX_CONCURRENT_FRAGMENTS].
   * Passed to yt-dlp as `-N`. */
  concurrentFragments: number;
  /** Integer in [MIN_CONCURRENT_DOWNLOADS, MAX_CONCURRENT_DOWNLOADS].
   * Queue's simultaneous-active cap. */
  concurrentDownloads: number;
  /** Free-input "yt-dlp command" string. When non-empty it overrides
   * the auto-built argv: the runner parses this string with shell-quote
   * semantics and spawns the resulting argv (plus the URL). Empty /
   * undefined = auto mode (Pluck builds the command from the other
   * settings). The text is stored verbatim — no normalisation — so the
   * Settings panel renders exactly what the user typed. */
  ytDlpCommandOverride?: string;
  /** Whether the Developer accordion in Settings is expanded. Persists
   * across restarts so a power user who's poking at debug flags doesn't
   * have to re-open the section every launch. Default is closed
   * (false) so first-launch users aren't faced with a wall of advanced
   * controls when they open Settings to change their output folder. */
  developerSectionOpen: boolean;
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
  // Only outputFolder is required. Other fields are merged under
  // defaults in createSettingsStore so a partially-written file (or
  // one missing a field) reads cleanly rather than carrying
  // `undefined` forward.
  if (typeof s.outputFolder !== 'string') {
    return false;
  }
  // The non-outputFolder fields (cookiesFromBrowser, debugMode,
  // concurrentFragments, concurrentDownloads) are all optional on
  // disk — additive schema. Reject only if PRESENT and the wrong type;
  // missing is fine and the defaults-spread in createSettingsStore
  // fills it in.
  if (s.debugMode !== undefined && typeof s.debugMode !== 'boolean') {
    return false;
  }
  // concurrentFragments is similarly optional. When present must be an
  // integer in range — a stray "100" in the JSON would otherwise sail
  // through to yt-dlp and likely trip rate limits.
  if (s.concurrentFragments !== undefined) {
    const n = s.concurrentFragments;
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      return false;
    }
    if (n < MIN_CONCURRENT_FRAGMENTS || n > MAX_CONCURRENT_FRAGMENTS) {
      return false;
    }
  }
  if (s.concurrentDownloads !== undefined) {
    const n = s.concurrentDownloads;
    if (typeof n !== 'number' || !Number.isInteger(n)) {
      return false;
    }
    if (n < MIN_CONCURRENT_DOWNLOADS || n > MAX_CONCURRENT_DOWNLOADS) {
      return false;
    }
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
  // ytDlpCommandOverride is free-form when present; we only require
  // it to be a string. Validation of its CONTENTS (whether it parses,
  // whether the first token is `yt-dlp`) happens at use time so the
  // user can save a partial command without the file getting rejected.
  if (s.ytDlpCommandOverride !== undefined && typeof s.ytDlpCommandOverride !== 'string') {
    return false;
  }
  // developerSectionOpen is optional on disk; defaults below.
  if (s.developerSectionOpen !== undefined && typeof s.developerSectionOpen !== 'boolean') {
    return false;
  }
  return true;
};

/** File-backed settings. `dir` is typically `app.getPath('userData')`;
 * passed in (not imported) so the module is testable outside Electron.
 * Loads at construction so `get()` is synchronous afterward. */
export const createSettingsStore = async (dir: string): Promise<SettingsStore> => {
  const filePath = join(dir, SETTINGS_FILENAME);

  const defaults: Settings = {
    outputFolder: defaultOutputFolder(),
    debugMode: false,
    concurrentFragments: DEFAULT_CONCURRENT_FRAGMENTS,
    concurrentDownloads: DEFAULT_CONCURRENT_DOWNLOADS,
    developerSectionOpen: false,
  };
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
