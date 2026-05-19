import type { DownloadRequest, PlaylistContext } from '../../shared/types';

/** One entry in yt-dlp's `formats` array. Subset of fields we read for
 * format-selection logic. yt-dlp may emit additional fields per entry
 * (filesize_approx, language, fragments, etc.) — we ignore them. */
export type FormatInfo = {
  /** Container extension, e.g. "mp4", "webm", "m4a". */
  ext: string;
  /** yt-dlp's video-codec id; the literal "none" means audio-only. */
  vcodec: string;
  /** yt-dlp's audio-codec id; the literal "none" means video-only. */
  acodec: string;
  /** Pixel dimensions. Missing for audio-only entries. */
  width?: number;
  height?: number;
  fps?: number;
  /** Total bitrate (audio + video) in Kbps, used as a tiebreaker when
   * width/height/fps are equal. yt-dlp may omit this. */
  tbr?: number;
};

/**
 * Subset of `yt-dlp -J` metadata we actually consume. yt-dlp returns hundreds
 * of fields; only the ones used by the UI / queue / transcriber appear here.
 */
export type VideoMetadata = {
  id: string;
  title: string;
  /** yt-dlp's extractor key (e.g. "youtube", "vimeo", "generic"). */
  extractor: string;
  durationSec?: number;
  uploader?: string;
  /** Absolute https URL of a preview thumbnail. yt-dlp picks one of several
   * resolutions; we just use whatever it gives us. */
  thumbnailUrl?: string;
  /** Raw formats array as yt-dlp reported it. Used by format-selector.ts
   * to compute per-URL FormatChoice labels (real resolution, fps,
   * container) and to decide whether a non-mp4 alternative deserves the
   * optional 5th dropdown slot. Empty array when yt-dlp couldn't enumerate
   * formats (audio-only URL, single-stream extractor). */
  formats: FormatInfo[];
  /** Set when the metadata fetch reports a playlist context.
   *   - For a video-in-playlist URL (`watch?v=X&list=Y`): yt-dlp's `-J`
   *     output gives the single video's metadata plus a `playlist` /
   *     `playlist_id` / `playlist_title` / `playlist_count` field — we
   *     project those here so the renderer can prompt "just this video
   *     or the whole playlist?"
   *   - For an explicit playlist URL (`playlist?list=Y`): yt-dlp emits
   *     `_type: 'playlist'` with an `entries` array; parseMetadata
   *     surfaces the same shape so the prompt UX is uniform.
   * Undefined for plain single-video URLs. */
  playlistContext?: PlaylistContext;
};

export const PROGRESS_STATUSES = ['downloading', 'finished', 'error'] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];

/**
 * One progress emission parsed off yt-dlp's stdout stream, line by line.
 * yt-dlp writes both its info chatter and `--progress-template` JSON to
 * stdout (despite the conventional split); this is the typed shape of the
 * JSON lines. parseProgressLine drops the non-JSON noise.
 */
export type ProgressEvent = {
  status: ProgressStatus;
  /** 0–100. May be NaN for unknown duration; callers should clamp/ignore. */
  percent: number;
  speed?: string;
  eta?: string;
};

/** Dependencies a runner needs to spawn yt-dlp. Passed in so the module is
 * testable outside Electron (where `binPath` from `paths.ts` requires `app`). */
export type RunnerDeps = {
  ytDlpPath: string;
  ffmpegPath: string;
};

/** What the runner needs to drive a single yt-dlp invocation.
 *
 * Note `tempFolder` instead of `outputFolder`: the runner downloads + merges
 * into a hidden per-download workspace. The caller (IPC handler / smoke
 * script) moves the final file into the user-visible output folder once
 * yt-dlp completes. Keeping the runner ignorant of the final destination
 * keeps yt-dlp orchestration and filesystem staging cleanly separated and
 * means a failed download leaves nothing in the user's Downloads folder.
 *
 * `cancelSignal` is the standard DOM AbortSignal. When it aborts mid-run,
 * the runner sends SIGTERM to the yt-dlp child, schedules SIGKILL after a
 * grace period, and rejects with YtDlpCancelledError. */
export type RunDownloadOptions = Omit<DownloadRequest, 'outputFolder' | 'format'> & {
  /** Args carried by the chosen FormatChoice. Spread directly into yt-dlp's
   * argv — caller built them already (either from STATIC_FORMAT_CHOICES
   * or from format-selector.ts after a per-URL probe). The runner doesn't
   * inspect or modify these; opaque pass-through. */
  ytDlpFormatArgs: string[];
  tempFolder: string;
  onProgress?: (event: ProgressEvent) => void;
  cancelSignal?: AbortSignal;
  /** When set, yt-dlp gets `--cookies-from-browser <name>` so it can
   * read the user's login cookies for sites that require auth (age-
   * gated YouTube, private Vimeo, LinkedIn, etc.). Plain string here
   * — the BrowserName union lives in settings.ts; this module stays
   * unaware of the allowed set so the runner module has zero settings
   * coupling. */
  cookiesFromBrowser?: string;
  /** Optional raw-stderr tap for the debug log box. The runner calls
   * this for every stderr line (post-readline). Caller decides what
   * to do with the firehose — typically forwards each line as a
   * DebugLogEvent. Subscribing has a cost (one closure per line), so
   * callers should only set this when debug mode is on. */
  onRawLine?: (line: string) => void;
  /** yt-dlp `-N` value (parallel HTTP fragments). Falls back to the
   * runner's default when undefined. Callers (queue, smoke harness)
   * pass the live settings value so a user change applies to the
   * next started download. */
  concurrentFragments?: number;
  /** Free-input override of the yt-dlp argv. When set and the string
   * parses cleanly (first token literally `yt-dlp`), the parsed argv
   * replaces the auto-built format / cookies / `-N` portion of the
   * command. Framework flags (`--paths`, `-o`, `--progress-template`,
   * `--print-to-file`, `--ffmpeg-location`) are always emitted by the
   * builder so progress + final-path tracking stay intact regardless.
   * A parse failure silently falls through to the auto path so a
   * broken override can't wedge new downloads. */
  ytDlpCommandOverride?: string;
  /** When set, passes `--sleep-requests <n>` to yt-dlp — sleep this
   * many seconds between extractor requests. Used to smooth the
   * metadata-fetch burst from playlist rows running in parallel.
   * Undefined = no sleep (yt-dlp's default). */
  requestSleepSeconds?: number;
};

/** Per-call options for the metadata fetch. Same `cookiesFromBrowser`
 * semantic as RunDownloadOptions — yt-dlp's metadata endpoint also
 * gates auth-required videos, so the same flag has to pass through. */
export type FetchMetadataOptions = {
  cookiesFromBrowser?: string;
};

export type RunDownloadResult = {
  /** Absolute path to the merged final file, inside the temp folder. */
  filePath: string;
};

/** Sentinel error subclasses so callers can distinguish failure modes without
 * regex-matching strings. */
export class YtDlpError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'YtDlpError';
  }
}

export class YtDlpPasswordRequiredError extends YtDlpError {
  constructor(stderr?: string) {
    super('yt-dlp requires a video password for this URL', stderr);
    this.name = 'YtDlpPasswordRequiredError';
  }
}

/** Thrown when the IPC layer aborts a download via AbortSignal (user clicked
 * Cancel). Distinct from YtDlpError so the IPC handler can emit
 * `status: 'cancelled'` instead of the user-scary `status: 'failed'` —
 * cancellation isn't a failure, it's a deliberate choice. */
export class YtDlpCancelledError extends YtDlpError {
  constructor() {
    super('Download cancelled by user.');
    this.name = 'YtDlpCancelledError';
  }
}

/** Thrown when yt-dlp couldn't read cookies for the configured browser —
 * Keychain access denied (Chromium-family) or no Full Disk Access (Safari).
 * The `browser` field carries the name so the renderer can craft a
 * per-browser actionable message ("click Allow on the Keychain prompt"
 * vs "grant Full Disk Access in System Settings"). */
export class YtDlpCookieAccessDeniedError extends YtDlpError {
  constructor(
    public readonly browser: string,
    stderr?: string,
  ) {
    super(`yt-dlp could not access ${browser} cookies`, stderr);
    this.name = 'YtDlpCookieAccessDeniedError';
  }
}
