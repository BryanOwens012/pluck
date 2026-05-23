/**
 * Shared types. Must contain ONLY type declarations — no runtime imports of
 * electron, node, or DOM APIs. Both the main and renderer processes import
 * from here.
 */

/** Stable ids for the six built-in format presets. */
export const FORMAT_IDS = ['best', '1080p', '720p', '480p', '360p', 'audio_mp3'] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

/** What the renderer picks and what the runner consumes. The id is
 * stable across UI / IPC / history; `label` is the always-visible
 * base name (e.g. "Best", "1080p mp4"); `detail` is the post-probe
 * suffix shown for the Best entry (e.g. "1080p mp4", "4K mkv") — the
 * label becomes "Best (1080p mp4)" via the FormatSelector; `shorthand`
 * is a terse resolution bucket retained as a structured field for
 * future use; `ytDlpFormatArgs` carries the actual yt-dlp flags.
 * Storing the args frozen at enqueue time means Retry replays the
 * same flag set even if the source URL's available formats have
 * changed since.
 *
 * For video presets the args are like `['-f', '...', '-S', 'res,vcodec:h264,fps']`.
 * For audio_mp3 they're `['-x', '--audio-format', 'mp3', '--audio-quality', '0']`.
 * Empty args is valid in principle (would let yt-dlp pick its own
 * default) but not used today. */
export type FormatChoice = {
  id: FormatId;
  label: string;
  shorthand?: string;
  detail?: string;
  ytDlpFormatArgs: string[];
};

/** Flags shared by every audio-bearing preset (mp3 + every video, since
 * video files carry audio too). `--embed-thumbnail` writes the
 * thumbnail as cover art (mp4 `covr` atom via ffmpeg, ID3v2 APIC for
 * mp3) so Finder Get Info / Music.app / QuickTime show it. `--add-
 * metadata` writes title / uploader / description into mp4 metadata
 * atoms (or ID3v2 tags). */
const AUDIO_EMBED_FLAGS = ['--embed-thumbnail', '--add-metadata'] as const;

/** Video-only additions on top of the audio flags. Currently just an
 * alias — subtitle flags moved out to
 * `src/main/downloader/subtitles/flags.ts` because they're applied
 * conditionally at spawn time based on cookies. */
export const VIDEO_EMBED_FLAGS = AUDIO_EMBED_FLAGS;

/** Sort priority for every video preset: highest resolution first,
 * then prefer h264 codec (M1/M2 hardware decode; QuickTime native),
 * then higher framerate. Putting `vcodec:h264` ahead of `fps` means a
 * 1080p30 h264 stream wins over a 1080p60 AV1 stream that would
 * otherwise pick on the fps tiebreaker. */
const VIDEO_SORT_FLAGS = ['-S', 'res,vcodec:h264,fps'] as const;

/** Build the yt-dlp `-f` selector for a video preset.
 *
 * Two distinct shapes depending on whether the caller passes a height
 * cap:
 *
 * **Tier-capped (1080p / 720p / 480p / 360p) — STRICT:**
 *   1. `bv*[ext=mp4][vcodec!*=av01]<h>+ba[ext=m4a]` — preferred merge
 *      pair (separate video + audio streams).
 *   2. `b[ext=mp4][vcodec!*=av01]<h>` — single muxed non-AV1 mp4
 *      (Zoom, pre-merged CDN links).
 *
 *   No further fallback. When the user picks "720p" they're committing
 *   to mp4 h264 — that label implies a specific container/codec in
 *   every other tool they've used. If the site offers no non-AV1 mp4
 *   at or below the cap, the download fails rather than silently
 *   handing them an AV1 or WebM file under the same label. The user
 *   can fall back to "Best" if they want the highest-quality option
 *   regardless of container. Because `[height<=N]` doesn't require an
 *   exact match, "1080p selected but only 720p mp4 exists" still
 *   downloads the 720p mp4 — only a complete absence of non-AV1 mp4
 *   triggers the strict failure.
 *
 * **Unrestricted ("Best" — omit `maxHeight`) — CASCADING:**
 *   1. `bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]` — preferred merge.
 *   2. `b[ext=mp4][vcodec!*=av01]` — single muxed non-AV1 mp4.
 *   3. `b[ext=mp4]` — relax the AV1 filter for AV1-only mp4 sources.
 *   4. `b` — anything (webm, mkv, mov) when no mp4 exists at all.
 *
 *   The "Best" label is permissive by design — it means "give me what
 *   you've got", so single-stream sites (Zoom mp4 with unknown codec)
 *   and AV1-only sources still produce a downloaded file. */
const mp4VideoSelector = (maxHeight?: number): string => {
  if (maxHeight !== undefined) {
    const h = `[height<=${maxHeight}]`;
    return [`bv*[ext=mp4][vcodec!*=av01]${h}+ba[ext=m4a]`, `b[ext=mp4][vcodec!*=av01]${h}`].join(
      '/',
    );
  }
  return [
    'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]',
    'b[ext=mp4][vcodec!*=av01]',
    'b[ext=mp4]',
    'b',
  ].join('/');
};

/** Quality-first "Best" for the pre-probe placeholder. Differs from
 * the post-probe mp4-biased `best` in one key way: no container
 * restriction. The `-S res,vcodec:h264,fps` sort still prefers h264
 * (so 1080p YouTube stays mp4), but at 4K YouTube only has VP9/WebM
 * available — no mp4 — so h264 preference is moot and the user gets
 * the actual highest quality (4K WebM merged to mkv) instead of
 * silently capping at 1080p mp4. Audio pinned to m4a so 1080p sources
 * (h264 video + m4a audio) merge to clean mp4.
 *
 * AV1 is excluded as a hard filter: M1 Macs can't hardware-decode it,
 * and QuickTime playback is unreliable. On YouTube, this means 8K
 * (which is AV1-only on YouTube) can't be downloaded — the selector
 * caps at the highest non-AV1 stream (4K VP9). Users who want AV1
 * can use the override box in Settings → Developer.
 *
 * Used as the initial format selection and as the "Best" entry of
 * PROBING_PLACEHOLDER_CHOICES. After the probe lands, the renderer
 * swaps this for the enriched post-probe "Best" whose detail string
 * describes the actual resolution + merged container the user will
 * get ("1080p mp4" / "4K mkv"). */
export const QUALITY_FIRST_BEST_CHOICE: FormatChoice = {
  id: 'best',
  label: 'Best',
  ytDlpFormatArgs: [
    '-f',
    // Pin audio to m4a so a 1080p YouTube source (h264 mp4 + m4a) merges
    // to clean mp4 instead of mkv (the mixed-container fallback). At
    // resolutions above 1080p where only WebM video exists, m4a audio
    // is still available — yt-dlp merges to mkv in that case, which
    // matches what the user sees in the "Best (4K mkv)" post-probe
    // label.
    'bv*[vcodec!*=av01]+ba[ext=m4a]/b[vcodec!*=av01]/b',
    ...VIDEO_SORT_FLAGS,
    ...VIDEO_EMBED_FLAGS,
  ],
};

/** Static fallback table — used by the renderer before a URL probe
 * runs. Labels are generic ("Best") because we don't know per-URL
 * dimensions until format-selector runs on a fetched metadata pass. */
export const STATIC_FORMAT_CHOICES: Record<FormatId, FormatChoice> = {
  best: {
    id: 'best',
    label: 'Best',
    ytDlpFormatArgs: ['-f', mp4VideoSelector(), ...VIDEO_SORT_FLAGS, ...VIDEO_EMBED_FLAGS],
  },
  '1080p': {
    id: '1080p',
    label: '1080p mp4',
    ytDlpFormatArgs: ['-f', mp4VideoSelector(1080), ...VIDEO_SORT_FLAGS, ...VIDEO_EMBED_FLAGS],
  },
  '720p': {
    id: '720p',
    label: '720p mp4',
    ytDlpFormatArgs: ['-f', mp4VideoSelector(720), ...VIDEO_SORT_FLAGS, ...VIDEO_EMBED_FLAGS],
  },
  '480p': {
    id: '480p',
    label: '480p mp4',
    ytDlpFormatArgs: ['-f', mp4VideoSelector(480), ...VIDEO_SORT_FLAGS, ...VIDEO_EMBED_FLAGS],
  },
  '360p': {
    id: '360p',
    label: '360p mp4',
    ytDlpFormatArgs: ['-f', mp4VideoSelector(360), ...VIDEO_SORT_FLAGS, ...VIDEO_EMBED_FLAGS],
  },
  audio_mp3: {
    id: 'audio_mp3',
    label: 'Audio-only mp3',
    // `--audio-quality 0` is LAME `-V 0` — variable bitrate, highest
    // quality. The encoder adapts per-frame to the source: complex
    // audio gets allocated up to 320 kbps (LAME's hard ceiling),
    // simple audio gets less. Net effect matches the desired policy
    // of "match what the source provides, never exceed 320 kbps"
    // without needing a separate probe-then-encode pipeline. Source
    // audio is whatever yt-dlp picks as bestaudio (default for `-x`).
    ytDlpFormatArgs: ['-x', '--audio-format', 'mp3', '--audio-quality', '0', ...AUDIO_EMBED_FLAGS],
  },
};

/** Ordered list of the static presets — renderer uses this to populate
 * the dropdown before any URL probe. */
export const STATIC_FORMAT_CHOICES_ORDERED: readonly FormatChoice[] = [
  STATIC_FORMAT_CHOICES.best,
  STATIC_FORMAT_CHOICES['1080p'],
  STATIC_FORMAT_CHOICES['720p'],
  STATIC_FORMAT_CHOICES['480p'],
  STATIC_FORMAT_CHOICES['360p'],
  STATIC_FORMAT_CHOICES.audio_mp3,
];

/** Browsers yt-dlp can pull cookies from. Subset of yt-dlp's full list
 * (chromium, opera, vivaldi, whale also work) — these are the common
 * ones we surface in the Settings dropdown. Lives in shared/ so both
 * the renderer dropdown and main's settings validator can read it. */
export const BROWSER_NAMES = ['chrome', 'firefox', 'safari', 'brave', 'edge'] as const;
export type BrowserName = (typeof BROWSER_NAMES)[number];

/** Lifecycle phase boundaries the queue + runner emit when debug mode
 * is on. The renderer renders these in the per-download log box.
 * `ytdlp` is the catch-all for raw stderr lines from yt-dlp itself
 * (forwarded line-by-line; not parsed). */
export const DEBUG_LOG_PHASES = [
  'metadata:start',
  'metadata:done',
  'download:start',
  'download:progress',
  'download:done',
  'move:start',
  'move:done',
  'cleanup:done',
  'error',
  'ytdlp',
] as const;
export type DebugLogPhase = (typeof DEBUG_LOG_PHASES)[number];

/** One line in a per-download debug log buffer. `id` is the Download
 * id; `timestamp` is Date.now() at emit time so the renderer can show
 * elapsed time without owning a clock. */
export type DebugLogEvent = {
  id: string;
  phase: DebugLogPhase;
  message: string;
  timestamp: number;
};

export type DownloadRequest = {
  url: string;
  format: FormatChoice;
  /** Optional. If omitted, the main process falls back to the
   * user-configured default output folder from settings. */
  outputFolder?: string;
  videoPassword?: string;
  /** Set when this request is one entry inside a playlist enqueue.
   * The id is the same `Playlist.id` shared by every entry of the
   * playlist (typically yt-dlp's `playlist_id`), so the renderer
   * can group rows visually. Undefined for plain single-video
   * downloads. */
  playlistId?: string;
  /** Display label for the playlist this request belongs to. Copied
   * onto the Download by the queue so the renderer can render the
   * group header without an extra lookup. */
  playlistTitle?: string;
  /** 1-based position of this entry within its playlist. */
  playlistIndex?: number;
  /** Total count of entries in the parent playlist. */
  playlistTotal?: number;
};

/** Lightweight summary of the playlist a video belongs to. Just enough
 * for the prompt UI to read "<title> (47 videos)". The full per-entry
 * enumeration is a separate fetch (yt-dlp -J --flat-playlist on the
 * playlist URL). */
export type PlaylistContext = {
  /** yt-dlp's `playlist_id` — e.g. YouTube's `list=` param value. */
  id: string;
  /** yt-dlp's `playlist_title`. May fall back to the id when missing. */
  title: string;
  /** yt-dlp's `playlist_count`. May be undefined for some extractors
   * that don't pre-count. */
  entryCount?: number;
  /** True when the URL is an EXPLICIT playlist URL (`playlist?list=Y`
   * shape — yt-dlp returned `_type: 'playlist'`). False when it's a
   * video URL that happens to carry playlist context. Changes the
   * "Just this video" button copy to "Just the first video". */
  isExplicitPlaylistUrl: boolean;
};

/** One entry returned by enumeratePlaylist — a single video the user
 * will enqueue as part of a playlist. Just URL + title + duration; the
 * full per-video metadata (formats, thumbnail) gets fetched at runOne
 * time same as a single-video download. */
export type PlaylistEntry = {
  url: string;
  title: string;
  /** yt-dlp's `playlist_index` (1-based). Preserved so the renderer
   * can show "3 of 47" per row. */
  index: number;
  durationSec?: number;
};

/** Hard cap on how many entries we enqueue from a playlist in one go.
 * Larger playlists prompt a warning in the modal and only the first N
 * are queued. The cap is a safety net against accidentally pasting a
 * URL that resolves to thousands of entries (e.g., a YouTube channel
 * page). Power users with a real 500-video playlist can run multiple
 * passes using yt-dlp's `--playlist-items` slice via the override
 * field in Settings → Developer → yt-dlp command. */
export const PLAYLIST_ENTRY_CAP = 200;

/** Direction the user chose at the playlist prompt — only used for
 * the `enumeratePlaylist` IPC arg; persisted nowhere. */
export const PLAYLIST_ORDERS = ['oldest_first', 'newest_first'] as const;
export type PlaylistOrder = (typeof PLAYLIST_ORDERS)[number];

export const DOWNLOAD_STATUSES = [
  'queued',
  'downloading',
  'canceling',
  'needs_password',
  'needs_cookies',
  'completed',
  'failed',
  'cancelled',
  'transcribing',
] as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number];

export type Download = {
  id: string;
  url: string;
  title?: string;
  sourceSite?: string;
  durationSec?: number;
  /** From `VideoMetadata.uploader`. Captured at metadata-fetch time
   * inside the queue and stamped on the row so the filename builder
   * (and any future Retry / re-name flow) can reach it without
   * re-querying yt-dlp. */
  uploader?: string;
  /** yt-dlp's `upload_date`, kept in `YYYYMMDD` form. Same capture
   * timing as `uploader`. */
  uploadDate?: string;
  /** Remote https URL for a preview thumbnail, populated after the metadata
   * pre-pass. Renderer loads it directly; CSP permits `img-src https:`. */
  thumbnailUrl?: string;
  format: FormatChoice;
  outputFolder: string;
  filePath?: string;
  status: DownloadStatus;
  /** 0–100 */
  progress: number;
  speed?: string;
  eta?: string;
  error?: string;
  /** Count of password submissions that failed for this row. Capped at
   * MAX_PASSWORD_ATTEMPTS in the queue (3); past that the row terminates
   * as 'failed' rather than re-prompting. Undefined on rows that never
   * needed a password. */
  passwordAttempts?: number;
  createdAt: number;
  completedAt?: number;
  /** Path to .srt if transcribed. Set once
   * `transcriptionStatus.state === 'done'` so the renderer can show
   * an "Open SRT" affordance. */
  transcriptPath?: string;
  /** Sub-state for the transcription pipeline. Independent from
   * `status` — a row can be `'completed'` (download finished) AND
   * be mid-transcription (`transcriptionStatus.state === 'transcribing'`).
   * Undefined / `{state: 'idle'}` means transcription hasn't been
   * kicked off yet. */
  transcriptionStatus?: TranscriptionStatus;
  /** Shell-safe display string of the exact yt-dlp command spawned
   * for this row, with the URL substituted in. Stamped on the
   * Download once at runOne time (before the spawn) so the per-row
   * debug preview can render it without re-deriving from scattered
   * settings. Password values are redacted. */
  invocationPreview?: string;
  /** Size in bytes of the final file on disk, captured via `fs.stat`
   * after the move into the destination folder completes. Used by the
   * debug-mode row to show "size + duration" alongside the saved-to
   * path. Undefined on failure paths (no file landed). */
  fileSizeBytes?: number;
  /** Set when this row was enqueued as part of a playlist. Same id is
   * shared across every entry of the playlist so the renderer can
   * group + render a playlist header above the constituent rows.
   * Undefined for plain single-video downloads. */
  playlistId?: string;
  /** Display label for the playlist this row belongs to. Copied from
   * the PlaylistContext at enqueue time so the renderer can render
   * the group header without needing to look it up. */
  playlistTitle?: string;
  /** 1-based position of this entry inside the playlist. Used in the
   * row UI ("3 of 47"). */
  playlistIndex?: number;
  /** Total count of entries in the parent playlist at enqueue time.
   * Used alongside `playlistIndex` for the row UI. */
  playlistTotal?: number;
};

export type TranscriptionStatus =
  | { state: 'idle' }
  | { state: 'extracting_audio' }
  | { state: 'uploading' }
  | { state: 'transcribing'; progress?: number }
  | { state: 'writing_srt' }
  | { state: 'done'; srtPath: string }
  | { state: 'error'; message: string };

export type AIToolCall = {
  name: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type AIResponse = {
  /** Claude's final natural-language reply. */
  text: string;
  /** What Claude did, for UI display. */
  toolCalls: AIToolCall[];
};

/** Subset of yt-dlp flags whose values mirror into the Settings UI when
 * the override is active. Extracted from a parsed override argv so the
 * informational dropdowns (concurrent fragments, cookies) can show what
 * the override decoded to while being disabled. */
export type ExtractedFlags = {
  concurrentFragments?: number;
  cookiesFromBrowser?: BrowserName;
  format?: string;
  outputTemplate?: string;
};

/** Result of parsing + extracting a user-supplied yt-dlp override
 * string. `ok: true` carries the post-`yt-dlp`-token argv plus the
 * known-flag extractions; `ok: false` carries a human-readable parse
 * error for inline display next to the override input. */
export type ParseYtDlpCommandResult =
  | { ok: true; argv: string[]; extracted: ExtractedFlags }
  | { ok: false; error: string };
