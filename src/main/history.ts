import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { type Download, type FormatId, STATIC_FORMAT_CHOICES } from '../shared/types';
import { atomicWriteJson } from './atomic-json';

/** Hard cap on persisted entries. When a write would exceed this, oldest
 * (by createdAt) is dropped. 50 is the spec's number — keeps the JSON file
 * small (< 50 KB even with long titles and paths) and keeps the renderer's
 * initial list reasonable. */
const MAX_ENTRIES = 50;

/** Schema version. Bump on any breaking change to the on-disk shape so we
 * can migrate or discard cleanly. Currently v1 — initial schema. */
const SCHEMA_VERSION = 1;

const HISTORY_FILENAME = 'history.json';

type HistoryFile = {
  version: number;
  downloads: Download[];
};

/** "Was running when the app exited and never got to write a terminal
 * update" — promoted to 'failed' on boot with a specific message so the
 * user can tell crash-rescue from a genuine yt-dlp failure. */
const INTERRUPTED_STATUSES = new Set(['downloading', 'queued']);

const INTERRUPTED_ERROR = 'Interrupted by app exit.';

export type HistoryStore = {
  /** Snapshot of what's persisted. Boot path returns this with in-flight
   * rows already rewritten to 'failed' (see INTERRUPTED_STATUSES). */
  load(): Promise<Download[]>;
  /** Persist via atomic-json. Power loss can't leave a half-written
   * history.json — the rename is atomic on a single APFS volume. */
  save(downloads: Download[]): Promise<void>;
};

/** File-backed history. `dir` is typically `app.getPath('userData')`; passed
 * in (not imported) so the module is testable outside Electron. */
export const createHistoryStore = (dir: string): HistoryStore => {
  const filePath = join(dir, HISTORY_FILENAME);

  const load = async (): Promise<Download[]> => {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      // ENOENT is the first-run case — fine, return empty. Any other read
      // error (EACCES on a permissions glitch) also degrades to empty so
      // the app boots cleanly rather than refusing to start.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('history: failed to read', filePath, err);
      }
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Corrupt JSON (manual edit, partial write from a pre-atomic version
      // of this code, disk corruption) — log and start clean. Don't refuse
      // to boot just because history is unreadable.
      console.error('history: corrupt JSON, starting clean', err);
      return [];
    }
    if (!isHistoryFile(parsed)) {
      console.error('history: schema mismatch, starting clean');
      return [];
    }
    // Two passes: migrate legacy `format: string` rows to FormatChoice
    // (PR 9.6b changed the shape), then promote any interrupted-by-quit
    // rows to terminal states. Order matters — promotion expects the
    // post-migration shape.
    return parsed.downloads.map(migrateLegacyFormat).map(promoteInterruptedToFailed);
  };

  const save = async (downloads: Download[]): Promise<void> => {
    const capped = capToMax(downloads, MAX_ENTRIES);
    const body: HistoryFile = { version: SCHEMA_VERSION, downloads: capped };
    await atomicWriteJson(filePath, body);
  };

  return { load, save };
};

/** Sort by createdAt ascending then keep the most-recent `max`. Oldest fall
 * off the bottom. Exported for testing. */
export const capToMax = (downloads: Download[], max: number): Download[] => {
  if (downloads.length <= max) {
    return downloads;
  }
  return [...downloads].sort((a, b) => a.createdAt - b.createdAt).slice(-max);
};

const isHistoryFile = (value: unknown): value is HistoryFile => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj.version === SCHEMA_VERSION &&
    Array.isArray(obj.downloads) &&
    obj.downloads.every((d) => typeof d === 'object' && d !== null && 'id' in d)
  );
};

/** Migrate legacy `format: 'best'` (string union from pre-PR-9.6b) into
 * the new `format: FormatChoice` object shape. Lookup table is the four
 * static presets — anything else falls back to 'best' to keep retry
 * working. Exported for testing.
 *
 * The cast on `download` is the necessary cost of a runtime migration —
 * we're explicitly handling the type-shape evolution. */
export const migrateLegacyFormat = (download: Download): Download => {
  const fmt = (download as unknown as Record<string, unknown>).format;
  if (typeof fmt !== 'string') {
    // Already the new shape (or undefined, which we don't write but
    // tolerate on read).
    return download;
  }
  // The string was one of FormatId minus 'best_alt'. 'best_alt' only
  // ever appears as the dynamic 5th option — never written to history
  // as a string. Anything else (corrupted, manually edited): fall back
  // to 'best' so the row stays usable.
  const id = fmt as FormatId;
  const choice =
    id === 'best' || id === '1080p' || id === '720p' || id === 'audio_mp3'
      ? STATIC_FORMAT_CHOICES[id]
      : STATIC_FORMAT_CHOICES.best;
  return { ...download, format: choice };
};

/** Boot-path rewrite: any row left in a non-terminal state at app exit
 * needs to be moved to a terminal one — there's no live process to ever
 * push the real terminal update. 'canceling' becomes 'cancelled' (the
 * user meant to cancel, so honour the intent). 'queued' and 'downloading'
 * become 'failed' with a clear interrupted message, distinct from a
 * real yt-dlp failure. Exported for testing. */
export const promoteInterruptedToFailed = (download: Download): Download => {
  if (download.status === 'canceling') {
    return {
      ...download,
      status: 'cancelled',
      completedAt: download.completedAt ?? Date.now(),
      speed: undefined,
      eta: undefined,
    };
  }
  if (!INTERRUPTED_STATUSES.has(download.status)) {
    return download;
  }
  return {
    ...download,
    status: 'failed',
    error: INTERRUPTED_ERROR,
    speed: undefined,
    eta: undefined,
  };
};
