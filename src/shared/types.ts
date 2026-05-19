/**
 * Shared types. Must contain ONLY type declarations — no runtime imports of
 * electron, node, or DOM APIs. Both the main and renderer processes import
 * from here.
 */

/** Stable ids for the four built-in format presets. The optional 5th
 * dropdown entry (a non-mp4 alternative when it strictly beats best mp4)
 * uses the dynamic id 'best_alt'. Any future ids land here too. */
export const FORMAT_IDS = ['best', '1080p', '720p', 'audio_mp3', 'best_alt'] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

/** What the renderer picks and what the runner consumes. The id is
 * stable across UI / IPC / history; `label` is the always-visible base
 * name ("Best"); `shorthand` is a terse resolution bucket
 * ("4K", "1080p") shown next to the label in non-debug mode — only the
 * `best` preset populates this since "1080p" / "720p" are already the
 * label, and audio_mp3 has no resolution; `detail` is the full per-URL
 * specifics ("1920×1080 mp4, 60fps") which the UI only renders in
 * debug mode (or always, for the `best_alt` 5th option whose entire
 * purpose is to surface a different container); `ytDlpFormatArgs`
 * carries the actual yt-dlp flags. Storing the args frozen at enqueue
 * time means Retry replays the same flag set even if the source URL's
 * available formats have changed since.
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

/** Video-only additions on top of the audio flags. `--embed-subs`
 * embeds subtitle tracks inside the container. `--write-auto-subs`
 * makes yt-dlp also fetch YouTube's auto-generated captions (the
 * default is manually-uploaded subs only, which most YouTube videos
 * lack). `--sub-langs en.*,en-orig` covers English variants + the
 * `en-orig` code YouTube assigns to live-stream auto-captions.
 * Unknown lang codes on non-YouTube sources are silently ignored.
 * Exported so format-selector.ts can reuse them on the dynamic
 * best_alt entry. */
export const VIDEO_EMBED_FLAGS = [
  ...AUDIO_EMBED_FLAGS,
  '--embed-subs',
  '--write-auto-subs',
  '--sub-langs',
  'en.*,en-orig',
] as const;

/** Sort priority for every video preset: highest resolution first,
 * then prefer h264 codec (M1/M2 hardware decode; QuickTime native),
 * then higher framerate. Putting `vcodec:h264` ahead of `fps` means a
 * 1080p30 h264 stream wins over a 1080p60 AV1 stream that would
 * otherwise pick on the fps tiebreaker. */
const VIDEO_SORT_FLAGS = ['-S', 'res,vcodec:h264,fps'] as const;

/** Selector for the best mp4 stream at or below `maxHeight` — pinned
 * to mp4 container, AV1 codec excluded (M1/M2 can't hardware-decode
 * AV1 well, and QuickTime treats some AV1-in-mp4 files as corrupt).
 * Falls back to a single-file mp4 if the bv*+ba merge isn't
 * available. Pass `undefined` for "unrestricted" (the Best preset). */
const mp4VideoSelector = (maxHeight: number | undefined): string => {
  const heightClause = maxHeight === undefined ? '' : `[height<=${maxHeight}]`;
  return `bv*[ext=mp4][vcodec!*=av01]${heightClause}+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]${heightClause}`;
};

/** Static fallback table — used by the renderer before a URL probe
 * runs. Labels are generic ("Best") because we don't know per-URL
 * dimensions until format-selector runs on a fetched metadata pass. */
export const STATIC_FORMAT_CHOICES: Record<Exclude<FormatId, 'best_alt'>, FormatChoice> = {
  best: {
    id: 'best',
    label: 'Best',
    ytDlpFormatArgs: ['-f', mp4VideoSelector(undefined), ...VIDEO_SORT_FLAGS, ...VIDEO_EMBED_FLAGS],
  },
  '1080p': {
    id: '1080p',
    label: '1080p',
    ytDlpFormatArgs: ['-f', mp4VideoSelector(1080), ...VIDEO_SORT_FLAGS, ...VIDEO_EMBED_FLAGS],
  },
  '720p': {
    id: '720p',
    label: '720p',
    ytDlpFormatArgs: ['-f', mp4VideoSelector(720), ...VIDEO_SORT_FLAGS, ...VIDEO_EMBED_FLAGS],
  },
  audio_mp3: {
    id: 'audio_mp3',
    label: 'Audio only (mp3)',
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
};

export const DOWNLOAD_STATUSES = [
  'queued',
  'downloading',
  'canceling',
  'needs_password',
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
  /** Path to .srt if transcribed. */
  transcriptPath?: string;
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
