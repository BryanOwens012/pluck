/**
 * Zod 4 schemas for every renderer→main IPC payload that takes user
 * input. Centralized here so each handler in ipc.ts gets one
 * uniform `safeParse(arg)` validation pass instead of the hand-rolled
 * `typeof === ...` chains that used to live inline.
 *
 * **Source of truth for types stays in `shared/types.ts`.** These
 * schemas mirror those types — TypeScript catches drift at every
 * place a schema's parsed output flows into a typed function. We
 * deliberately don't use `z.infer<typeof Schema>` for the runtime
 * types because the renderer needs the same types without depending
 * on Zod.
 *
 * **What this module is for** (and isn't):
 *   - For: catching malformed payloads at the IPC boundary —
 *     missing fields, wrong types, unknown enum values — and giving
 *     handlers one consistent rejection path.
 *   - Not for: business-rule validation. Things like "the
 *     downloadId must be one we know about" or "the
 *     concurrentFragments setting can't exceed the global max" stay
 *     in the handler / queue where they belong.
 *
 * **Zod 4 idiom notes** (we're on zod@^4.4.3):
 *   - Top-level format helpers (`z.url`, `z.int`, etc.) instead of
 *     the chained `z.string().url()` / `z.number().int()` deprecated
 *     in v4.
 *   - `z.strictObject(...)` instead of `z.object(...).strict()` —
 *     payloads with unknown keys are rejected, which surfaces typos
 *     and over-posting bugs in the renderer immediately.
 *   - `Schema.nullish()` instead of `z.union([Schema, z.null()]).optional()`
 *     for fields where both `null` and `undefined` are valid signals.
 *   - Issue customization via `{ error: '...' }` (the `{ message }`
 *     form is deprecated in v4).
 */
import { z } from 'zod';
import { BROWSER_NAMES, FORMAT_IDS, PLAYLIST_ORDERS } from '../shared/types';
import { SECRET_NAMES } from './secrets';
import {
  MAX_CONCURRENT_DOWNLOADS,
  MAX_CONCURRENT_FRAGMENTS,
  MIN_CONCURRENT_DOWNLOADS,
  MIN_CONCURRENT_FRAGMENTS,
} from './settings';

/** Strict http(s) URL string. Rejects `file://` / `javascript:` /
 * `mailto:` / `ftp:` — anything whose scheme isn't `http` or `https`.
 *
 * `z.url()` is Zod 4's top-level URL helper (Zod 3's
 * `z.string().url()` is deprecated). It defaults to accepting ANY
 * scheme the WHATWG URL parser recognizes; the `protocol` option
 * filters that down. The regex `/^https?$/` matches the protocol
 * name without its trailing colon — exactly the two we want.
 *
 * Renderer normalizes scheme-less input before sending (PR 9.8), so
 * by the time the URL reaches the IPC boundary it's expected to be
 * already-schemed. */
export const HttpUrlSchema = z.url({
  protocol: /^https?$/,
  error: 'Must be an http(s) URL',
});

/** Non-empty string. Used for download ids, file paths, passwords —
 * anywhere an empty string is meaningless and should be rejected
 * the same as a missing value. */
export const NonEmptyStringSchema = z.string().min(1);

/** Enums backed by the const arrays already in shared types — pulls
 * the runtime values straight from the source of truth, so the
 * schemas can't drift from the union types. Zod 4 `z.enum(tuple)`
 * accepts either a `const` tuple or a TypeScript native enum. */
export const BrowserNameSchema = z.enum(BROWSER_NAMES);
export const SecretNameSchema = z.enum(SECRET_NAMES);
export const PlaylistOrderSchema = z.enum(PLAYLIST_ORDERS);
export const FormatIdSchema = z.enum(FORMAT_IDS);

/** Mirrors `FormatChoice` from `shared/types.ts`. Renderer sends a
 * complete FormatChoice in `DownloadRequest` and
 * `StartPlaylistDownload` payloads — we re-validate the shape here
 * so a compromised renderer can't smuggle arbitrary objects into
 * `queue.enqueue`. Strict-object rejects unknown keys so a typo in
 * the renderer never silently maps to an undefined slot. */
export const FormatChoiceSchema = z.strictObject({
  id: FormatIdSchema,
  label: z.string(),
  shorthand: z.string().optional(),
  detail: z.string().optional(),
  ytDlpFormatArgs: z.array(z.string()),
});

/** Mirrors `PlaylistContext`. Used inside `StartPlaylistDownload`. */
export const PlaylistContextSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  entryCount: z.number().optional(),
  isExplicitPlaylistUrl: z.boolean(),
});

/** Mirrors `PlaylistEntry` — one row produced by enumerate. The
 * per-entry URL is re-validated as http(s) so a bogus enumerate
 * result can't sneak past the URL guard either. Used at the
 * individual-entry-validation layer (caller picks this when it
 * wants to fail closed on any bad entry). */
export const PlaylistEntrySchema = z.strictObject({
  url: HttpUrlSchema,
  title: z.string(),
  index: z.number(),
  durationSec: z.number().optional(),
});

/** Loose `PlaylistEntry` shape — same fields, no URL validation.
 * Used inside the `StartPlaylistDownload` array so a single bad URL
 * in the enumerate result doesn't tank the whole batch (the handler
 * loops and re-validates each entry's URL via `HttpUrlSchema`,
 * skipping bad ones individually). */
export const PlaylistEntryShapeSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  index: z.number(),
  durationSec: z.number().optional(),
});

/** Mirrors `DownloadRequest` — the payload for StartDownload. */
export const DownloadRequestSchema = z.strictObject({
  url: HttpUrlSchema,
  format: FormatChoiceSchema,
  outputFolder: z.string().optional(),
  videoPassword: z.string().optional(),
  playlistId: z.string().optional(),
  playlistTitle: z.string().optional(),
  playlistIndex: z.number().optional(),
  playlistTotal: z.number().optional(),
});

/** Payload for StartPlaylistDownload — array of entries plus the
 * full context. The handler's own logic re-orders + slices, but the
 * shape lives here. `entries: [].min(1)` rejects empty playlists at
 * the schema layer (renderer also guards, this is defense in depth).
 *
 * Entries are validated with the LOOSE shape (no per-URL http
 * check). The handler re-validates each entry's URL via
 * `HttpUrlSchema` inside its loop, skipping bad ones individually so
 * a single dud entry from yt-dlp doesn't kill the whole batch. */
export const StartPlaylistDownloadSchema = z.strictObject({
  entries: z.array(PlaylistEntryShapeSchema).min(1),
  format: FormatChoiceSchema,
  playlistContext: PlaylistContextSchema,
  order: PlaylistOrderSchema,
});

/** Payload for the TestApiKey / SaveApiKey IPC handlers. Two
 * positional args go in (name, key) but we model them as one object
 * here for symmetry — the handler reconstructs from positional. */
export const ApiKeyCredentialsSchema = z.strictObject({
  name: SecretNameSchema,
  key: NonEmptyStringSchema,
});

/** Payload for UpdateSettings — every field optional because the
 * renderer sends a patch, not a full settings object. Field rules:
 *   - outputFolder: non-empty string only (empty rejected; missing
 *     keeps the existing value)
 *   - cookiesFromBrowser: BrowserName OR null (explicit clear) — key
 *     presence at the handler decides "no change" vs "set to null".
 *     `.nullish()` accepts both `null` and `undefined`.
 *   - debugMode: boolean
 *   - concurrentFragments: integer in [MIN_, MAX_CONCURRENT_FRAGMENTS]
 *   - concurrentDownloads: integer in [MIN_, MAX_CONCURRENT_DOWNLOADS]
 *   - ytDlpCommandOverride: string OR null (clear) — same key-
 *     presence semantics as cookies. Empty string is also "clear"
 *     for ergonomic Settings input handling.
 *   - developerSectionOpen: boolean
 *
 * Note: this schema validates SHAPE. The key-presence-means-clear
 * logic stays in the handler — Zod's parse output normalizes absent
 * vs. explicit-undefined to the same `key: undefined` form, so the
 * handler reads keys off the raw payload (not the parsed output) to
 * distinguish "leave alone" from "clear". */
export const UpdateSettingsPatchSchema = z.strictObject({
  outputFolder: NonEmptyStringSchema.optional(),
  cookiesFromBrowser: BrowserNameSchema.nullish(),
  debugMode: z.boolean().optional(),
  concurrentFragments: z
    .int()
    .min(MIN_CONCURRENT_FRAGMENTS)
    .max(MAX_CONCURRENT_FRAGMENTS)
    .optional(),
  concurrentDownloads: z
    .int()
    .min(MIN_CONCURRENT_DOWNLOADS)
    .max(MAX_CONCURRENT_DOWNLOADS)
    .optional(),
  ytDlpCommandOverride: z.string().nullish(),
  developerSectionOpen: z.boolean().optional(),
  transcriptionEnabled: z.boolean().optional(),
});
