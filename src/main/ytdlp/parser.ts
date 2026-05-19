import type { PlaylistContext, PlaylistEntry } from '../../shared/types';
import {
  YtDlpFlatPlaylistEntrySchema,
  YtDlpFlatPlaylistSchema,
  YtDlpFormatSchema,
  YtDlpPlaylistMetadataSchema,
  YtDlpProgressLineSchema,
  YtDlpVideoMetadataSchema,
} from './schemas';
import type { FormatInfo, ProgressEvent, VideoMetadata } from './types';

/** Tokens yt-dlp emits when a field is missing — we treat any of
 * these as "unknown" and surface as undefined so downstream UI
 * doesn't render a literal "N/A" string. */
const UNKNOWN_TOKENS = new Set(['Unknown', 'N/A', '', 'NA']);

const cleanOptional = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return UNKNOWN_TOKENS.has(trimmed) ? undefined : trimmed;
};

/**
 * Parse a single line off yt-dlp's stdout stream. Returns null for any line
 * that isn't a JSON progress emission — runner.ts feeds every line through
 * here without prefiltering, which is fine because parsing is cheap and we
 * want a single source of truth for what counts as progress.
 */
export const parseProgressLine = (line: string): ProgressEvent | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = YtDlpProgressLineSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  // `_percent_str` is rendered like " 42.3%" or "100%" or "N/A". Strip the "%"
  // and any padding; if it doesn't parse, fall through with NaN so the caller
  // can decide whether to ignore the event.
  const percentRaw = (parsed.data.percent ?? '').replace('%', '').trim();
  const percent = Number.parseFloat(percentRaw);
  return {
    status: parsed.data.status,
    percent: Number.isFinite(percent) ? percent : Number.NaN,
    speed: cleanOptional(parsed.data.speed),
    eta: cleanOptional(parsed.data.eta),
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
  const raw = JSON.parse(json) as unknown;

  // Dispatch on `_type` BEFORE validating against the video schema —
  // the playlist shape doesn't carry the required (id, title,
  // extractor) fields on its top level the way the video shape does,
  // so trying to validate it as a video would throw spuriously.
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { _type?: unknown })._type === 'playlist'
  ) {
    return parsePlaylistShape(raw);
  }

  const parsed = YtDlpVideoMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('yt-dlp metadata missing required fields (id, title, extractor)');
  }
  const data = parsed.data;
  return {
    id: data.id,
    title: data.title,
    extractor: data.extractor,
    durationSec: data.duration,
    uploader: data.uploader,
    uploadDate: data.upload_date,
    thumbnailUrl: data.thumbnail,
    formats: parseFormats(data.formats),
    playlistContext: parsePlaylistContextFromVideoRecord(data),
  };
};

/** Build a uniform `VideoMetadata` from an explicit-playlist `-J`
 * record (`_type: 'playlist'`). We synthesize the video-level fields
 * from the first entry so callers don't have to special-case this
 * shape — the playlist prompt UI is what actually reads the
 * `playlistContext` and decides what to do. */
const parsePlaylistShape = (raw: unknown): VideoMetadata => {
  const parsed = YtDlpPlaylistMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    // We only get here after the caller verified `_type === 'playlist'`,
    // so this would only fire if the rest of the playlist shape is
    // pathological. Throw with the same message the video path uses
    // so downstream error handling treats both the same.
    throw new Error('yt-dlp metadata missing required fields (id, title, extractor)');
  }
  const data = parsed.data;
  const playlistId = data.id ?? '';
  const playlistTitle = data.title ?? playlistId;
  const extractor = data.extractor ?? 'unknown';
  const entries = data.entries ?? [];

  // Stand in with first-entry data so the row preview the renderer
  // shows before the user picks "first video" vs "whole playlist"
  // isn't blank. If the entries array is empty (rare), the synthetic
  // record falls back to playlist-level fields.
  const firstEntry = (entries[0] ?? null) as Record<string, unknown> | null;
  const firstParsed = firstEntry
    ? YtDlpVideoMetadataSchema.partial({
        id: true,
        title: true,
        extractor: true,
      }).safeParse(firstEntry)
    : { success: false as const };

  const id = firstParsed.success && firstParsed.data.id ? firstParsed.data.id : playlistId;
  const firstTitle = firstParsed.success ? firstParsed.data.title : undefined;
  const duration = firstParsed.success ? firstParsed.data.duration : undefined;
  const uploader = firstParsed.success ? firstParsed.data.uploader : undefined;
  const uploadDate = firstParsed.success ? firstParsed.data.upload_date : undefined;
  const thumbnailUrl = firstParsed.success ? firstParsed.data.thumbnail : undefined;
  const formatsRaw = firstParsed.success ? firstParsed.data.formats : undefined;

  const entryCount =
    data.playlist_count !== undefined
      ? data.playlist_count
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
    formats: parseFormats(formatsRaw),
    playlistContext: {
      id: playlistId,
      title: playlistTitle,
      entryCount,
      isExplicitPlaylistUrl: true,
    },
  };
};

/** Read `playlist_*` fields off a video-shaped `-J` record. Returns
 * undefined unless yt-dlp surfaced a playlist context — yt-dlp does
 * this whenever the URL carried `&list=Y` even for video-shape
 * downloads. */
const parsePlaylistContextFromVideoRecord = (data: {
  playlist_id?: string;
  playlist_title?: string;
  playlist_count?: number;
}): PlaylistContext | undefined => {
  if (data.playlist_id === undefined) {
    return undefined;
  }
  return {
    id: data.playlist_id,
    title: data.playlist_title ?? data.playlist_id,
    entryCount: data.playlist_count,
    isExplicitPlaylistUrl: false,
  };
};

/** Extract the `formats` array from `yt-dlp -J` output. yt-dlp always
 * includes this for multi-stream extractors (YouTube, Vimeo) and
 * sometimes for single-stream ones (direct .mp4 URLs). Anything that
 * fails the per-entry schema (missing ext / vcodec / acodec, wrong
 * types) is dropped — yt-dlp occasionally emits half-built format
 * entries during extractor edge cases. */
const parseFormats = (raw: unknown): FormatInfo[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: FormatInfo[] = [];
  for (const entry of raw) {
    const parsed = YtDlpFormatSchema.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    out.push({
      ext: parsed.data.ext,
      vcodec: parsed.data.vcodec,
      acodec: parsed.data.acodec,
      width: parsed.data.width,
      height: parsed.data.height,
      fps: parsed.data.fps,
      tbr: parsed.data.tbr,
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
  const raw = JSON.parse(json) as unknown;
  const parsed = YtDlpFlatPlaylistSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const rawEntries = parsed.data.entries ?? [];
  const out: PlaylistEntry[] = [];
  for (let i = 0; i < rawEntries.length; i += 1) {
    const entryParsed = YtDlpFlatPlaylistEntrySchema.safeParse(rawEntries[i]);
    if (!entryParsed.success) {
      continue;
    }
    const entry = entryParsed.data;
    if (entry.url === undefined || entry.title === undefined) {
      // yt-dlp occasionally emits half-built entries for unavailable
      // videos (deleted, private). Skip them — the `-i` flag at
      // download time covers the same intent for the live download.
      continue;
    }
    out.push({
      url: entry.url,
      title: entry.title,
      index: entry.playlist_index ?? i + 1,
      durationSec: entry.duration,
    });
  }
  return out;
};

/** Compose the playlist-level context (id, title, count) from the same
 * `--flat-playlist` -J output that `parsePlaylistEntries` reads. Used to
 * stamp `playlistTitle` etc. on each enqueued Download row. */
export const parsePlaylistContextFromFlat = (json: string): PlaylistContext | undefined => {
  const raw = JSON.parse(json) as unknown;
  const parsed = YtDlpFlatPlaylistSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  // Pull `id` out before the undefined check so TypeScript narrows
  // it to `string` for the return statement (vs. checking
  // `parsed.data.id` which TS doesn't always propagate).
  const id = parsed.data.id;
  if (id === undefined) {
    return undefined;
  }
  const data = parsed.data;
  const entryCount =
    data.playlist_count !== undefined
      ? data.playlist_count
      : Array.isArray(data.entries)
        ? data.entries.length
        : undefined;
  return {
    id,
    title: data.title ?? id,
    entryCount,
    isExplicitPlaylistUrl: true,
  };
};
