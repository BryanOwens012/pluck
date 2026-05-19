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
 * name ("Best quality"); `shorthand` is a terse resolution bucket
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

/** Static fallback table — used by the renderer before a URL probe
 * runs, and by history.ts to migrate legacy `format: 'best'` strings
 * to the new FormatChoice shape. mp4-default args from PR 9.6 Phase A.
 * Labels are generic ("Best quality") because we don't know per-URL
 * dimensions until format-selector runs on a fetched metadata pass. */
export const STATIC_FORMAT_CHOICES: Record<Exclude<FormatId, 'best_alt'>, FormatChoice> = {
  best: {
    id: 'best',
    label: 'Best quality',
    // `vcodec!*=av01` excludes AV1-in-mp4 streams. M1 / M2 Macs have no
    // hardware AV1 decode, so AV1 files play back stuttery and macOS
    // QuickTime treats some of them as corrupt. M3+ would be fine but
    // we're optimising for the lowest-common-denominator M-series Mac.
    // The 5th `best_alt` option still surfaces a higher-quality non-mp4
    // alternative (typically vp9-webm 1080p60) when one exists.
    ytDlpFormatArgs: [
      '-f',
      'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]',
      '-S',
      'res,vcodec:h264,fps',
    ],
  },
  '1080p': {
    id: '1080p',
    label: '1080p',
    ytDlpFormatArgs: [
      '-f',
      'bv*[ext=mp4][vcodec!*=av01][height<=1080]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=1080]',
      '-S',
      'res,vcodec:h264,fps',
    ],
  },
  '720p': {
    id: '720p',
    label: '720p',
    ytDlpFormatArgs: [
      '-f',
      'bv*[ext=mp4][vcodec!*=av01][height<=720]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=720]',
      '-S',
      'res,vcodec:h264,fps',
    ],
  },
  audio_mp3: {
    id: 'audio_mp3',
    label: 'Audio only (mp3)',
    ytDlpFormatArgs: ['-x', '--audio-format', 'mp3', '--audio-quality', '0'],
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
  /** Optional. If omitted, main process falls back to its configured default
   * (~/Downloads/Pluck until PR 6 introduces the settings-driven path). */
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
