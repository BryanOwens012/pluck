import type { PlaylistContext, PlaylistEntry } from '../../shared/types';
import type { FormatInfo, ProgressEvent, VideoMetadata } from './types';

/**
 * Shape of one progress line as configured by `--progress-template` in runner.ts.
 * yt-dlp's `_percent_str` includes a trailing "%"; speed/eta can be "Unknown".
 */
type RawProgress = {
  status?: string;
  percent?: string;
  speed?: string;
  eta?: string;
};

const UNKNOWN_TOKENS = new Set(['Unknown', 'N/A', '', 'NA']);

const cleanOptional = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return UNKNOWN_TOKENS.has(trimmed) ? undefined : trimmed;
};

/**
 * Parse a single line off yt-dlp's stderr stream. Returns null for any line
 * that isn't a JSON progress emission — runner.ts feeds every line through
 * here without prefiltering, which is fine because parsing is cheap and we
 * want a single source of truth for what counts as progress.
 */
export const parseProgressLine = (line: string): ProgressEvent | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  let raw: RawProgress;
  try {
    raw = JSON.parse(trimmed) as RawProgress;
  } catch {
    return null;
  }

  if (raw.status !== 'downloading' && raw.status !== 'finished' && raw.status !== 'error') {
    return null;
  }

  // `_percent_str` is rendered like " 42.3%" or "100%" or "N/A". Strip the "%"
  // and any padding; if it doesn't parse, fall through with NaN so the caller
  // can decide whether to ignore the event.
  const percentRaw = (raw.percent ?? '').replace('%', '').trim();
  const percent = Number.parseFloat(percentRaw);

  return {
    status: raw.status,
    percent: Number.isFinite(percent) ? percent : Number.NaN,
    speed: cleanOptional(raw.speed),
    eta: cleanOptional(raw.eta),
  };
};

/**
 * Parse the JSON object emitted by `yt-dlp -J --no-download <url>`. Throws if
 * the input isn't valid JSON or is missing the required identifier fields.
 * yt-dlp emits a huge object (hundreds of keys); we project to the subset we
 * actually use.
 *
 * Handles two shapes:
 *   - `_type: 'playlist'` with an `entries` array — the URL was an
 *     explicit playlist (`playlist?list=Y`). We synthesize a video-like
 *     record from the first entry so the rest of the app keeps a
 *     uniform shape, and attach the playlist info as `playlistContext`
 *     with `isExplicitPlaylistUrl: true`.
 *   - A normal video record with optional `playlist_id` /
 *     `playlist_title` / `playlist_count` fields (yt-dlp populates
 *     these when the URL was `watch?v=X&list=Y`). Those fields land in
 *     `playlistContext` with `isExplicitPlaylistUrl: false`.
 */
export const parseMetadata = (json: string): VideoMetadata => {
  const parsed = JSON.parse(json) as Record<string, unknown>;

  if (parsed._type === 'playlist') {
    return parsePlaylistShape(parsed);
  }

  const id = typeof parsed.id === 'string' ? parsed.id : undefined;
  const title = typeof parsed.title === 'string' ? parsed.title : undefined;
  const extractor = typeof parsed.extractor === 'string' ? parsed.extractor : undefined;

  if (!id || !title || !extractor) {
    throw new Error('yt-dlp metadata missing required fields (id, title, extractor)');
  }

  const duration = typeof parsed.duration === 'number' ? parsed.duration : undefined;
  const uploader = typeof parsed.uploader === 'string' ? parsed.uploader : undefined;
  const uploadDate = parseUploadDate(parsed.upload_date);
  const thumbnailUrl = typeof parsed.thumbnail === 'string' ? parsed.thumbnail : undefined;

  return {
    id,
    title,
    extractor,
    durationSec: duration,
    uploader,
    uploadDate,
    thumbnailUrl,
    formats: parseFormats(parsed.formats),
    playlistContext: parsePlaylistContextFromVideoRecord(parsed),
  };
};

/** Build a uniform `VideoMetadata` from an explicit-playlist `-J`
 * record (`_type: 'playlist'`). We synthesize the video-level fields
 * from the first entry so callers don't have to special-case this
 * shape — the playlist prompt UI is what actually reads the
 * `playlistContext` and decides what to do. */
const parsePlaylistShape = (parsed: Record<string, unknown>): VideoMetadata => {
  const playlistId = typeof parsed.id === 'string' ? parsed.id : '';
  const playlistTitle = typeof parsed.title === 'string' ? parsed.title : playlistId;
  const extractor = typeof parsed.extractor === 'string' ? parsed.extractor : 'unknown';
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const firstEntry = (entries[0] ?? {}) as Record<string, unknown>;

  // Stand in with first-entry data so the row preview the renderer
  // shows before the user picks "first video" vs "whole playlist"
  // isn't blank. If the entries array is empty (rare), the synthetic
  // record falls back to playlist-level fields.
  const id = typeof firstEntry.id === 'string' ? firstEntry.id : playlistId;
  const firstTitle = typeof firstEntry.title === 'string' ? firstEntry.title : undefined;
  const duration = typeof firstEntry.duration === 'number' ? firstEntry.duration : undefined;
  const uploader = typeof firstEntry.uploader === 'string' ? firstEntry.uploader : undefined;
  const uploadDate = parseUploadDate(firstEntry.upload_date);
  const thumbnailUrl = typeof firstEntry.thumbnail === 'string' ? firstEntry.thumbnail : undefined;
  const entryCount =
    typeof parsed.playlist_count === 'number'
      ? parsed.playlist_count
      : entries.length > 0
        ? entries.length
        : undefined;

  return {
    id,
    title: firstTitle ?? playlistTitle,
    extractor,
    durationSec: duration,
    uploader,
    uploadDate,
    thumbnailUrl,
    formats: parseFormats(firstEntry.formats),
    playlistContext: {
      id: playlistId,
      title: playlistTitle,
      entryCount,
      isExplicitPlaylistUrl: true,
    },
  };
};

/** Normalize yt-dlp's `upload_date` field. yt-dlp emits an 8-digit
 * YYYYMMDD string when the extractor provides one. We keep that
 * native form here and let the filename builder reshape it into
 * `YYYY-MM-DD` for display. Anything that isn't an 8-digit string
 * comes back as undefined so downstream code can fall through to its
 * default. */
const parseUploadDate = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') {
    return undefined;
  }
  if (!/^\d{8}$/.test(raw)) {
    return undefined;
  }
  return raw;
};

/** Read `playlist_*` fields off a video-shaped `-J` record. Returns
 * undefined unless yt-dlp surfaced a playlist context — yt-dlp does
 * this whenever the URL carried `&list=Y` even for video-shape
 * downloads. */
const parsePlaylistContextFromVideoRecord = (
  parsed: Record<string, unknown>,
): PlaylistContext | undefined => {
  const id = typeof parsed.playlist_id === 'string' ? parsed.playlist_id : undefined;
  if (id === undefined) {
    return undefined;
  }
  const title = typeof parsed.playlist_title === 'string' ? parsed.playlist_title : id;
  const entryCount = typeof parsed.playlist_count === 'number' ? parsed.playlist_count : undefined;
  return { id, title, entryCount, isExplicitPlaylistUrl: false };
};

/** Extract the `formats` array from `yt-dlp -J` output. yt-dlp always
 * includes this for multi-stream extractors (YouTube, Vimeo) and
 * sometimes for single-stream ones (direct .mp4 URLs). Anything that
 * isn't an object with at least an `ext` + `vcodec` + `acodec` is
 * dropped — yt-dlp occasionally emits half-built format entries during
 * extractor edge cases. */
const parseFormats = (raw: unknown): FormatInfo[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: FormatInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.ext !== 'string' || typeof e.vcodec !== 'string' || typeof e.acodec !== 'string') {
      continue;
    }
    out.push({
      ext: e.ext,
      vcodec: e.vcodec,
      acodec: e.acodec,
      width: typeof e.width === 'number' ? e.width : undefined,
      height: typeof e.height === 'number' ? e.height : undefined,
      fps: typeof e.fps === 'number' ? e.fps : undefined,
      tbr: typeof e.tbr === 'number' ? e.tbr : undefined,
    });
  }
  return out;
};

/**
 * Detect Zoom's password-required error from stderr. yt-dlp's exact wording
 * varies between extractor versions ("requires a password", "Authentication
 * required", "passcode"), so we match on the presence of a Zoom signal plus
 * any password/auth-related token. Pinned against yt-dlp 2026.03.17 —
 * re-verify on every yt-dlp bump.
 */
export const isPasswordRequiredError = (stderr: string): boolean => {
  return /zoom/i.test(stderr) && /(password|passcode|authentic)/i.test(stderr);
};

/**
 * Detect cookie-extraction failures from stderr — the user picked a browser
 * in Settings → Browser cookies, but macOS blocked yt-dlp from reading it.
 * Two scenarios:
 *
 * - Chromium-family (Chrome/Brave/Edge): macOS Keychain prompt was Denied
 *   (or never shown / dismissed). yt-dlp emits "could not decrypt cookie",
 *   "failed to access keyring", or similar.
 * - Safari: no Full Disk Access → "permission denied" on
 *   `~/Library/Cookies/Cookies.binarycookies`.
 *
 * We match on a cookie/keychain token plus a denial/decrypt/permission
 * token. False positives would be rare and the failure mode (showing a
 * "browser cookies denied" message on a real network error) is mild.
 * Pinned against yt-dlp 2026.03.17 — re-verify on every yt-dlp bump.
 */
export const isCookieAccessDeniedError = (stderr: string): boolean => {
  const cookieSignal = /(cookie|keychain|keyring)/i.test(stderr);
  const denialSignal = /(denied|decrypt|permission|cancell|aborted)/i.test(stderr);
  return cookieSignal && denialSignal;
};

/**
 * Parse the JSON object emitted by `yt-dlp -J --no-download --yes-playlist
 * --flat-playlist <url>`. Returns a flat list of `PlaylistEntry`s — one per
 * video in the playlist. Throws if the input isn't valid JSON.
 *
 * `--flat-playlist` short-circuits per-video metadata fetching, so each entry
 * is a stub (url, id, title, optional duration). The full metadata fetch
 * happens per row at runOne time via the existing metadata cache, same as a
 * single-video download.
 *
 * Returns an empty array (rather than throwing) for non-playlist shapes —
 * lets the caller decide whether that's an error or just "user pasted a
 * single-video URL we can't expand".
 */
export const parsePlaylistEntries = (json: string): PlaylistEntry[] => {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (parsed._type !== 'playlist' || !Array.isArray(parsed.entries)) {
    return [];
  }
  const out: PlaylistEntry[] = [];
  for (let i = 0; i < parsed.entries.length; i += 1) {
    const entry = parsed.entries[i] as Record<string, unknown> | null;
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const url = typeof entry.url === 'string' ? entry.url : undefined;
    const title = typeof entry.title === 'string' ? entry.title : undefined;
    if (url === undefined || title === undefined) {
      // yt-dlp occasionally emits half-built entries for unavailable
      // videos (deleted, private). Skip them — the `-i` flag at
      // download time covers the same intent for the live download.
      continue;
    }
    out.push({
      url,
      title,
      index: typeof entry.playlist_index === 'number' ? entry.playlist_index : i + 1,
      durationSec: typeof entry.duration === 'number' ? entry.duration : undefined,
    });
  }
  return out;
};

/** Compose the playlist-level context (id, title, count) from the same
 * `--flat-playlist` -J output that `parsePlaylistEntries` reads. Used to
 * stamp `playlistTitle` etc. on each enqueued Download row. */
export const parsePlaylistContextFromFlat = (json: string): PlaylistContext | undefined => {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (parsed._type !== 'playlist') {
    return undefined;
  }
  const id = typeof parsed.id === 'string' ? parsed.id : undefined;
  if (id === undefined) {
    return undefined;
  }
  const title = typeof parsed.title === 'string' ? parsed.title : id;
  const entryCount =
    typeof parsed.playlist_count === 'number'
      ? parsed.playlist_count
      : Array.isArray(parsed.entries)
        ? parsed.entries.length
        : undefined;
  return { id, title, entryCount, isExplicitPlaylistUrl: true };
};
