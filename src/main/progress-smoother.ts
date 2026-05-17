/**
 * Two-second-window smoother for the speed and ETA fields shown on a
 * DownloadRow. yt-dlp emits a progress event multiple times per second; the
 * raw values flicker and are hard to read. This module batches them so the
 * UI only updates `speed` and `eta` once every 2 seconds.
 *
 * Speed is averaged across the samples that landed in the window (parsed
 * to bytes/sec, mean, formatted back into a SI-prefixed string).
 *
 * ETA uses the most-recent sample's value. Averaging an ETA is conceptually
 * wrong — it's already a forecast, and the most recent forecast is the best
 * one. Throttling it to the same 2-second tick still gives the requested
 * stable display.
 *
 * Percent is NOT throttled here — it should keep updating every event for a
 * smooth progress-bar fill. The caller (ipc.ts) emits percent on every
 * progress callback regardless of what the smoother returns.
 */

const WINDOW_MS = 2000;

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

/** Render bytes-per-second back into a human-readable string. Always picks
 * the largest unit that keeps the integer portion ≤ 4 digits. */
export const formatBytesPerSec = (bps: number): string => {
  if (!Number.isFinite(bps) || bps < 0) {
    return '—';
  }
  if (bps < 1024) {
    return `${bps.toFixed(0)} B/s`;
  }
  if (bps < 1024 * 1024) {
    return `${(bps / 1024).toFixed(2)} KiB/s`;
  }
  if (bps < 1024 * 1024 * 1024) {
    return `${(bps / (1024 * 1024)).toFixed(2)} MiB/s`;
  }
  return `${(bps / (1024 * 1024 * 1024)).toFixed(2)} GiB/s`;
};

export const createProgressSmoother = (now: () => number = Date.now): ProgressSmoother => {
  const samples: number[] = [];
  let windowStartedAt = now();
  let published: SmoothedProgress = { speed: undefined, eta: undefined };

  return {
    sample(speed, eta) {
      const bps = parseSpeedToBytesPerSec(speed);
      if (bps !== undefined) {
        samples.push(bps);
      }

      // Bootstrap: seed the published value from the first parseable sample
      // so the user sees something during the first 2-second window rather
      // than waiting for the first tick.
      if (published.speed === undefined && bps !== undefined) {
        published = { speed: formatBytesPerSec(bps), eta };
      }

      const current = now();
      if (current - windowStartedAt < WINDOW_MS) {
        return;
      }

      // Tick: publish the window's average + the latest ETA, reset.
      if (samples.length > 0) {
        const mean = samples.reduce((sum, x) => sum + x, 0) / samples.length;
        published = { speed: formatBytesPerSec(mean), eta: eta ?? published.eta };
      } else if (eta !== undefined) {
        // No parseable speeds this window but ETA still got an update.
        published = { speed: published.speed, eta };
      }
      samples.length = 0;
      windowStartedAt = current;
    },
    current() {
      return published;
    },
  };
};
