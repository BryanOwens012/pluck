/**
 * Build the user-visible filename + per-playlist folder name for a
 * completed download. Pure helpers — no fs, no electron, no yt-dlp.
 * The queue calls these at move-time, after yt-dlp has merged the
 * file into the per-download tempFolder under yt-dlp's own filename
 * (`%(title)s.%(ext)s`); we then move-rename into the user's output
 * folder with the canonical pattern.
 *
 * Single-video pattern:
 *   `<Uploader> - <Title> (YYYY-MM-DD).<ext>`
 *
 * Playlist-row pattern (lands inside a per-playlist subfolder):
 *   `<NN> <Uploader> - <Title> (YYYY-MM-DD).<ext>`
 *
 * The uploader prefix drops out when the source didn't provide one.
 * The date always shows: upload_date when yt-dlp surfaced it, else
 * today's local date (so the filename is never date-less, even on
 * extractors that don't report upload_date — livestreams, some
 * non-YouTube sources).
 */

/** Filesystem-banned + Finder-hostile characters. macOS only forbids
 * `:` (Finder's path separator legacy) and `/` (POSIX path
 * separator), but we sanitize a wider set so a copy to a Windows
 * share / Linux backup / cloud sync doesn't break. Null, newlines,
 * and tabs would also confuse downstream tooling. */
const FILENAME_BANNED_CHARS = /[/\\:\n\r\t\0<>|?*"]/g;

/** Cap on each path segment (folder name OR filename stem). macOS
 * APFS allows 255 UTF-8 bytes per segment; many downstream tools
 * (Dropbox, older Windows volumes) choke earlier. 200 chars is
 * conservative and well below any real-world title length except for
 * pathological cases. */
const SEGMENT_LENGTH_CAP = 200;

/** Replace banned chars with a single space, collapse runs of
 * whitespace, trim leading/trailing whitespace AND leading/trailing
 * dots (Windows treats a trailing-dot filename as if the dot wasn't
 * there, which causes silent collisions), and cap at SEGMENT_LENGTH_CAP.
 * Returns an empty string for input that's all-banned or whitespace. */
const sanitizePathSegment = (raw: string): string => {
  return raw
    .replace(FILENAME_BANNED_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, SEGMENT_LENGTH_CAP);
};

/** yt-dlp's native `YYYYMMDD` → ISO `YYYY-MM-DD`. Returns undefined
 * for missing or malformed input so callers can fall back. */
const formatUploadDate = (yyyymmdd: string | undefined): string | undefined => {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) {
    return undefined;
  }
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
};

/** Local-time `YYYY-MM-DD`. Used as the date fallback when yt-dlp's
 * `upload_date` is missing (livestream-in-progress, generic
 * extractor, etc.) so the filename never ends up date-less. */
const todayLocalIsoDate = (now: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** Zero-pad the playlist index to match the width of the total —
 * `1 of 47` → `01`, `1 of 200` → `001`, `1 of 5` → `1`. Lexical
 * filename sort lines up with numeric order in every case. Falls
 * back to the index's own width when `total` is unknown. */
const formatPlaylistIndex = (index: number, total: number | undefined): string => {
  const width =
    total !== undefined && Number.isFinite(total) && total > 0
      ? String(Math.floor(total)).length
      : String(Math.max(1, Math.floor(index))).length;
  return String(Math.floor(index)).padStart(width, '0');
};

export type FinalFilenameInput = {
  /** From `VideoMetadata.title`. Empty / whitespace is tolerated —
   * the function falls back to `videoId` to ensure a non-empty stem. */
  title: string;
  /** Stable yt-dlp id, used as the ultimate fallback when the title
   * sanitizes to empty. */
  videoId: string;
  /** From `VideoMetadata.uploader`. When absent, the `<Uploader> - `
   * prefix is dropped entirely (no `" - Title"` orphan dash). */
  uploader?: string;
  /** yt-dlp's `upload_date` in `YYYYMMDD` form. When undefined or
   * malformed, the filename uses today's local date instead. */
  uploadDate?: string;
  /** File extension WITHOUT the leading dot (e.g. `"mp4"`, `"mp3"`).
   * The function prepends the dot. */
  ext: string;
  /** 1-based position within the parent playlist. Set ONLY for
   * playlist rows — single-video downloads leave this undefined and
   * skip the index prefix. */
  playlistIndex?: number;
  /** Total count of entries in the parent playlist. Used to compute
   * the zero-padding width for `playlistIndex`. Optional even when
   * `playlistIndex` is set (falls back to the index's own width). */
  playlistTotal?: number;
};

/** Compose the user-visible filename for a completed download. Pure;
 * caller is responsible for resolving collisions in the destination
 * folder (see `resolveAvailablePath` in `staging.ts`). */
export const buildFinalFilename = (input: FinalFilenameInput, now: Date = new Date()): string => {
  const titleStem = sanitizeOrFallback(input.title, input.videoId);
  const uploaderStem = input.uploader ? sanitizePathSegment(input.uploader) : '';

  const labeled = uploaderStem.length > 0 ? `${uploaderStem} - ${titleStem}` : titleStem;
  const dated = `${labeled} (${formatUploadDate(input.uploadDate) ?? todayLocalIsoDate(now)})`;

  const prefixed =
    input.playlistIndex !== undefined && Number.isFinite(input.playlistIndex)
      ? `${formatPlaylistIndex(input.playlistIndex, input.playlistTotal)} ${dated}`
      : dated;

  const stem = prefixed.slice(0, SEGMENT_LENGTH_CAP).trimEnd();
  // Same banned-char set as sanitizePathSegment, applied to the
  // extension defensively in case a caller passes an unusual one.
  const extStem = sanitizePathSegment(input.ext);
  return extStem.length > 0 ? `${stem}.${extStem}` : stem;
};

/** Pick a sanitized title, falling back to the (sanitized) videoId
 * when the title sanitizes to empty. Guarantees a non-empty stem —
 * a fully-empty filename would otherwise collide with every other
 * fully-empty filename in the destination folder. */
const sanitizeOrFallback = (title: string, videoId: string): string => {
  const titleSanitized = sanitizePathSegment(title);
  if (titleSanitized.length > 0) {
    return titleSanitized;
  }
  const idSanitized = sanitizePathSegment(videoId);
  return idSanitized.length > 0 ? idSanitized : 'untitled';
};

export type PlaylistFolderInput = {
  /** From `PlaylistContext.title`. May be empty/whitespace for some
   * extractors; the function falls back to `playlistId`. */
  playlistTitle?: string;
  /** Stable yt-dlp playlist id (`PLxxx` on YouTube). Used as the
   * folder-name fallback. */
  playlistId: string;
};

/** Compose the per-playlist subfolder name. The queue creates this
 * folder under the user's configured output folder and moves
 * playlist-row files into it. Returns the sanitized playlist title
 * when present, else the playlist id (which is always non-empty
 * since yt-dlp won't surface a playlist record without one). */
export const buildPlaylistFolderName = (input: PlaylistFolderInput): string => {
  const fromTitle = input.playlistTitle ? sanitizePathSegment(input.playlistTitle) : '';
  if (fromTitle.length > 0) {
    return fromTitle;
  }
  const fromId = sanitizePathSegment(input.playlistId);
  return fromId.length > 0 ? fromId : 'playlist';
};
