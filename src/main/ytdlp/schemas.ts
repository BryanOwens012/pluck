/**
 * Zod 4 schemas for `yt-dlp -J` JSON output. yt-dlp is a third-party
 * subprocess we don't control; its output shape varies by extractor,
 * yt-dlp version, and per-video edge cases. The schemas catch
 * malformed entries at the boundary so a quirky upstream emit
 * doesn't crash the renderer with a `cannot read property of
 * undefined` deep in some downstream consumer.
 *
 * **Loose by design.** Every schema uses `z.looseObject(...)` so
 * yt-dlp's hundreds of unmodeled fields pass through silently. We
 * only validate the subset of fields we actually consume. If yt-dlp
 * adds a new field, parsing stays green; if it changes the shape of
 * a field we do read, the per-row `safeParse` fails and the
 * permissive logic (skip half-built entries, fall back to defaults)
 * kicks in the same way the hand-rolled parser used to.
 *
 * Source of truth for the consumer-facing types (`VideoMetadata`,
 * `ProgressEvent`, `FormatInfo`, etc.) stays in `./types.ts`. These
 * schemas only validate yt-dlp's wire format on the way in.
 */
import { z } from 'zod';
import { PROGRESS_STATUSES } from './types';

/** Single `--progress-template` JSON line from yt-dlp's stdout. The
 * raw values are all strings (yt-dlp formats them server-side);
 * percent is normalized + parsed by `parseProgressLine`. */
export const YtDlpProgressLineSchema = z.looseObject({
  status: z.enum(PROGRESS_STATUSES),
  percent: z.string().optional(),
  speed: z.string().optional(),
  eta: z.string().optional(),
});

/** One entry inside a `-J` output's `formats` array. yt-dlp emits
 * ~30 fields per format; we only need ext + codecs + dimensions +
 * framerate + bitrate. Entries missing the three required string
 * fields (ext, vcodec, acodec) get skipped at the per-entry
 * safeParse layer. */
export const YtDlpFormatSchema = z.looseObject({
  ext: z.string(),
  vcodec: z.string(),
  acodec: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  tbr: z.number().optional(),
});

/** Common metadata fields shared by both video- and playlist-shape
 * `-J` outputs. Pulled into one place so the two top-level schemas
 * stay in sync.
 *
 * Every optional field uses `.catch(undefined)` so a single
 * malformed value (yt-dlp emits an unexpected type for one field)
 * doesn't fail the whole parse — instead the field comes back
 * undefined and downstream consumers fall through to their
 * defaults. Matches the hand-rolled parser's "drop wrong types
 * silently" behavior. Required fields (id, title, extractor) still
 * fail the whole parse if missing, because there's nothing useful
 * to synthesize without them. */
const baseMetadataFields = {
  id: z.string(),
  title: z.string(),
  extractor: z.string(),
  duration: z.number().optional().catch(undefined),
  uploader: z.string().optional().catch(undefined),
  /** yt-dlp's native `YYYYMMDD` string. The regex rejects anything
   * else so downstream `parseUploadDate`-style normalization can
   * trust the format. */
  upload_date: z
    .string()
    .regex(/^\d{8}$/)
    .optional()
    .catch(undefined),
  thumbnail: z.string().optional().catch(undefined),
  formats: z.array(z.unknown()).optional().catch(undefined),
  // Playlist context fields populated when the URL was a
  // `watch?v=X&list=Y` shape — yt-dlp surfaces playlist_id /
  // playlist_title / playlist_count on the video record.
  playlist_id: z.string().optional().catch(undefined),
  playlist_title: z.string().optional().catch(undefined),
  playlist_count: z.number().optional().catch(undefined),
};

/** Video-shape `-J` output — the URL pointed at a single video.
 * `id`, `title`, `extractor` are required: missing means yt-dlp
 * couldn't extract anything useful and we should treat the parse as
 * a failure, not synthesize a half-broken Download row. */
export const YtDlpVideoMetadataSchema = z.looseObject(baseMetadataFields);

/** Explicit-playlist `-J` output (`_type: 'playlist'`). Every field
 * here is optional because the parser synthesizes a video-like
 * record from whatever it gets — empty entries array, missing
 * title, etc. all fall through to sensible defaults so the prompt
 * UI doesn't have to special-case this shape. */
export const YtDlpPlaylistMetadataSchema = z.looseObject({
  _type: z.literal('playlist'),
  id: z.string().optional(),
  title: z.string().optional(),
  extractor: z.string().optional(),
  entries: z.array(z.unknown()).optional(),
  playlist_count: z.number().optional(),
});

/** One entry inside the `--flat-playlist` output's `entries` array.
 * Loose for the same reason as `YtDlpFormatSchema` — only the
 * fields the parser reads are modeled. The per-entry `url` and
 * `title` are optional because yt-dlp occasionally emits half-built
 * entries for unavailable videos (deleted / private) — the parser
 * skips those without raising. */
export const YtDlpFlatPlaylistEntrySchema = z.looseObject({
  url: z.string().optional(),
  title: z.string().optional(),
  playlist_index: z.number().optional(),
  duration: z.number().optional(),
});

/** Top-level `--flat-playlist` output. Shape mirrors the explicit-
 * playlist schema but with `entries` typed as the lighter
 * flat-shape array. */
export const YtDlpFlatPlaylistSchema = z.looseObject({
  _type: z.literal('playlist'),
  id: z.string().optional(),
  title: z.string().optional(),
  playlist_count: z.number().optional(),
  entries: z.array(z.unknown()).optional(),
});
