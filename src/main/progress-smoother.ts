/**
 * Two-second-window smoother for the speed and ETA fields shown on a
 * DownloadRow. yt-dlp emits a progress event multiple times per second; the
 * raw values flicker and are hard to read. This module batches them so the
 * UI only updates `speed` and `eta` once every 2 seconds.
 *
 * Speed: simple arithmetic mean of the samples that landed in the window
 * (parsed to bytes/sec, mean, formatted back into a SI-prefixed string).
 * The window-mean is stable, easy to read, and clearly tied to the
 * "last 2 seconds" mental model.
 *
 * ETA: exponentially-smoothed because yt-dlp's raw ETA = remaining_bytes /
 * instantaneous_speed, which jitters violently with `-N 14` parallel chunks
 * (the community fix on yt-dlp's own tracker is exponential smoothing —
 * issues #2197, #4267, #8118). Each new sample contributes a small fraction
 * to the running estimate, so transient spikes get damped. The published
 * value still ticks at the 2-second cadence (matches the speed display) but
 * reflects the smoothed value instead of the raw most-recent.
 *
 * Percent is NOT throttled here — it should keep updating every event for a
 * smooth progress-bar fill. The caller (ipc.ts) emits percent on every
 * progress callback regardless of what the smoother returns.
 */

const WINDOW_MS = 2000;

// Exponential-smoothing factor for ETA. 0.9 means each new sample contributes
// 10% to the running estimate; a sustained change converges in ~5 samples
// (~1 second at yt-dlp's typical emission rate). Lower = more responsive but
// jittery; higher = smoother but laggy. 0.9 is what most of the community
// suggestions on yt-dlp's tracker land on.
const ETA_SMOOTHING_ALPHA = 0.9;

export type SmoothedProgress = {
  speed?: string;
  eta?: string;
};

export type ProgressSmoother = {
  /** Feed one raw progress sample. Both fields can be undefined when yt-dlp
   * couldn't compute them. */
  sample: (speed: string | undefined, eta: string | undefined) => void;
  /** Latest values to display. Stable between window ticks. */
  current: () => SmoothedProgress;
};

const SPEED_PATTERN = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\/s$/;

const SPEED_UNIT_BYTES: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
  GiB: 1024 * 1024 * 1024,
  TiB: 1024 * 1024 * 1024 * 1024,
};

/** Parse "5.30MiB/s" / "500.00 KiB/s" into bytes-per-second. Returns
 * undefined for anything that doesn't match — including yt-dlp's leftover
 * "Unknown B/s" or "N/A" strings. */
export const parseSpeedToBytesPerSec = (raw: string | undefined): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const match = raw.trim().match(SPEED_PATTERN);
  if (!match) {
    return undefined;
  }
  const value = Number.parseFloat(match[1] ?? '');
  const unit = match[2] ?? '';
  const multiplier = SPEED_UNIT_BYTES[unit];
  if (!Number.isFinite(value) || multiplier === undefined) {
    return undefined;
  }
  return value * multiplier;
};

/** Render bytes-per-second back into a human-readable string with SI
 * (decimal, base-1000) units — KB/MB/GB, not the binary KiB/MiB/GiB.
 * Decimal units are what macOS Finder, browsers, and most consumer
 * software use, so they're more familiar to non-technical users. yt-dlp's
 * input is binary (MiB/s), but we convert via the bytes/sec intermediate
 * and display whatever's friendliest. One decimal place keeps the value
 * tight ("5.6 MB/s" not "5.55 MB/s"). */
export const formatBytesPerSec = (bps: number): string => {
  if (!Number.isFinite(bps) || bps < 0) {
    return '—';
  }
  if (bps < 1000) {
    return `${bps.toFixed(0)} B/s`;
  }
  if (bps < 1_000_000) {
    return `${(bps / 1000).toFixed(1)} KB/s`;
  }
  if (bps < 1_000_000_000) {
    return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  }
  return `${(bps / 1_000_000_000).toFixed(1)} GB/s`;
};

const ETA_PATTERN = /^(\d{2,}):(\d{2})(?::(\d{2}))?$/;

/** Parse yt-dlp's `_eta_str` ("MM:SS" or "HH:MM:SS") into seconds. Returns
 * undefined for "Unknown" / "NA" / malformed values. */
export const parseEtaToSeconds = (raw: string | undefined): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }
  const match = raw.trim().match(ETA_PATTERN);
  if (!match) {
    return undefined;
  }
  const a = Number.parseInt(match[1] ?? '', 10);
  const b = Number.parseInt(match[2] ?? '', 10);
  const c = match[3] !== undefined ? Number.parseInt(match[3], 10) : undefined;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return undefined;
  }
  if (c !== undefined && Number.isFinite(c)) {
    return a * 3600 + b * 60 + c;
  }
  return a * 60 + b;
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Format a seconds count back into the same "MM:SS" / "HH:MM:SS" shape
 * the rest of the UI is used to from yt-dlp. */
export const formatSecondsToEta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  const rounded = Math.round(seconds);
  if (rounded < 3600) {
    return `${pad2(Math.floor(rounded / 60))}:${pad2(rounded % 60)}`;
  }
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
};

export const createProgressSmoother = (now: () => number = Date.now): ProgressSmoother => {
  const speedSamples: number[] = [];
  let etaEmaSec: number | undefined;
  let windowStartedAt = now();
  let published: SmoothedProgress = { speed: undefined, eta: undefined };

  return {
    sample(speed, eta) {
      const bps = parseSpeedToBytesPerSec(speed);
      if (bps !== undefined) {
        speedSamples.push(bps);
      }

      const etaSec = parseEtaToSeconds(eta);
      if (etaSec !== undefined) {
        // EMA: first sample bootstraps, subsequent samples decay toward the
        // new value. Smoothing across multi-stream transitions (video then
        // audio for a YouTube merge) is intentional — the ETA naturally
        // glides into the next stream's estimate instead of jumping.
        etaEmaSec =
          etaEmaSec === undefined
            ? etaSec
            : ETA_SMOOTHING_ALPHA * etaEmaSec + (1 - ETA_SMOOTHING_ALPHA) * etaSec;
      }

      // Bootstrap each field independently the first time a parseable
      // value arrives, so neither speed nor ETA is held back waiting on
      // the other. yt-dlp will emit "Unknown B/s" with a real ETA for the
      // first few hundred ms, so the eta-only path is real.
      if (published.speed === undefined && bps !== undefined) {
        published = { ...published, speed: formatBytesPerSec(bps) };
      }
      if (published.eta === undefined && etaEmaSec !== undefined) {
        published = { ...published, eta: formatSecondsToEta(etaEmaSec) };
      }

      const current = now();
      if (current - windowStartedAt < WINDOW_MS) {
        return;
      }

      // Tick: publish the window's mean speed + the EMA-smoothed ETA.
      const nextSpeed =
        speedSamples.length > 0
          ? formatBytesPerSec(speedSamples.reduce((sum, x) => sum + x, 0) / speedSamples.length)
          : published.speed;
      const nextEta = etaEmaSec !== undefined ? formatSecondsToEta(etaEmaSec) : published.eta;
      published = { speed: nextSpeed, eta: nextEta };
      speedSamples.length = 0;
      windowStartedAt = current;
    },
    current() {
      return published;
    },
  };
};
