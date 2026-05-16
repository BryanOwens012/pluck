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
  thumbnail?: string;
};

/**
 * One progress emission parsed off yt-dlp's stderr stream, line by line.
 * yt-dlp's `--progress-template` is configured to print JSON on stderr; this
 * is the typed shape of those lines.
 */
export type ProgressEvent = {
  status: 'downloading' | 'finished' | 'error';
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

/** Same shape as the renderer-facing `DownloadRequest`, plus a progress
 * callback. Keeping the wire-level type as the single source of truth means
 * the IPC handler can pass the request straight through with one extra field. */
export type RunDownloadOptions = DownloadRequest & {
  onProgress?: (event: ProgressEvent) => void;
};

export type RunDownloadResult = {
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
