import type { DownloadRequest } from '../../shared/types';

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
export type RunDownloadOptions = Omit<DownloadRequest, 'outputFolder'> & {
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
