import type { ProgressEvent, VideoMetadata } from './types';

/**
 * Shape of one progress line as configured by `--progress-template` in runner.ts.
 * yt-dlp's `_percent_str` includes a trailing "%"; speed/eta can be "Unknown".
 */
type RawProgress = {
  status?: string;
  percent?: string;
  speed?: string;
  eta?: string;
};

const UNKNOWN_TOKENS = new Set(['Unknown', 'N/A', '', 'NA']);

const cleanOptional = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return UNKNOWN_TOKENS.has(trimmed) ? undefined : trimmed;
};

/**
 * Parse a single line off yt-dlp's stderr stream. Returns null for any line
 * that isn't a JSON progress emission — runner.ts feeds every line through
 * here without prefiltering, which is fine because parsing is cheap and we
 * want a single source of truth for what counts as progress.
 */
export const parseProgressLine = (line: string): ProgressEvent | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  let raw: RawProgress;
  try {
    raw = JSON.parse(trimmed) as RawProgress;
  } catch {
    return null;
  }

  if (raw.status !== 'downloading' && raw.status !== 'finished' && raw.status !== 'error') {
    return null;
  }

  // `_percent_str` is rendered like " 42.3%" or "100%" or "N/A". Strip the "%"
  // and any padding; if it doesn't parse, fall through with NaN so the caller
  // can decide whether to ignore the event.
  const percentRaw = (raw.percent ?? '').replace('%', '').trim();
  const percent = Number.parseFloat(percentRaw);

  return {
    status: raw.status,
    percent: Number.isFinite(percent) ? percent : Number.NaN,
    speed: cleanOptional(raw.speed),
    eta: cleanOptional(raw.eta),
  };
};

/**
 * Parse the JSON object emitted by `yt-dlp -J --no-download <url>`. Throws if
 * the input isn't valid JSON or is missing the required identifier fields.
 * yt-dlp emits a huge object (hundreds of keys); we project to the subset we
 * actually use.
 */
export const parseMetadata = (json: string): VideoMetadata => {
  const parsed = JSON.parse(json) as Record<string, unknown>;

  const id = typeof parsed.id === 'string' ? parsed.id : undefined;
  const title = typeof parsed.title === 'string' ? parsed.title : undefined;
  const extractor = typeof parsed.extractor === 'string' ? parsed.extractor : undefined;

  if (!id || !title || !extractor) {
    throw new Error('yt-dlp metadata missing required fields (id, title, extractor)');
  }

  const duration = typeof parsed.duration === 'number' ? parsed.duration : undefined;
  const uploader = typeof parsed.uploader === 'string' ? parsed.uploader : undefined;
  const thumbnailUrl = typeof parsed.thumbnail === 'string' ? parsed.thumbnail : undefined;

  return {
    id,
    title,
    extractor,
    durationSec: duration,
    uploader,
    thumbnailUrl,
  };
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
