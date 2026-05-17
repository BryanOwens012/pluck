import { describe, expect, it, vi } from 'vitest';
import {
  createProgressSmoother,
  formatBytesPerSec,
  formatSecondsToEta,
  parseEtaToSeconds,
  parseSpeedToBytesPerSec,
} from './progress-smoother';

describe('parseSpeedToBytesPerSec', () => {
  it('parses common yt-dlp speed strings', () => {
    expect(parseSpeedToBytesPerSec('500.00KiB/s')).toBe(500 * 1024);
    expect(parseSpeedToBytesPerSec('5.30MiB/s')).toBeCloseTo(5.3 * 1024 * 1024);
    expect(parseSpeedToBytesPerSec('1.23GiB/s')).toBeCloseTo(1.23 * 1024 * 1024 * 1024);
    expect(parseSpeedToBytesPerSec('256 B/s')).toBe(256);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSpeedToBytesPerSec('   5.00MiB/s   ')).toBeCloseTo(5 * 1024 * 1024);
    expect(parseSpeedToBytesPerSec(' 500.00 KiB/s')).toBe(500 * 1024);
  });

  it('returns undefined for non-numeric / unknown values', () => {
    expect(parseSpeedToBytesPerSec('Unknown B/s')).toBeUndefined();
    expect(parseSpeedToBytesPerSec('N/A')).toBeUndefined();
    expect(parseSpeedToBytesPerSec('garbage')).toBeUndefined();
    expect(parseSpeedToBytesPerSec(undefined)).toBeUndefined();
    expect(parseSpeedToBytesPerSec('')).toBeUndefined();
  });
});

describe('formatBytesPerSec', () => {
  it('renders SI / decimal units (KB/MB/GB, not KiB/MiB/GiB) for a non-technical audience', () => {
    expect(formatBytesPerSec(500)).toBe('500 B/s');
    expect(formatBytesPerSec(2000)).toBe('2.0 KB/s');
    expect(formatBytesPerSec(5_000_000)).toBe('5.0 MB/s');
    expect(formatBytesPerSec(3_000_000_000)).toBe('3.0 GB/s');
  });

  it('uses one decimal place for readability', () => {
    // 12.5 * 1024 * 1024 binary bytes/s -> ~13.1 MB/s in decimal.
    expect(formatBytesPerSec(12.5 * 1024 * 1024)).toBe('13.1 MB/s');
    expect(formatBytesPerSec(1234)).toBe('1.2 KB/s');
  });

  it('returns em-dash for invalid input', () => {
    expect(formatBytesPerSec(Number.NaN)).toBe('—');
    expect(formatBytesPerSec(-1)).toBe('—');
    expect(formatBytesPerSec(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('parseEtaToSeconds', () => {
  it('parses MM:SS and HH:MM:SS', () => {
    expect(parseEtaToSeconds('00:30')).toBe(30);
    expect(parseEtaToSeconds('01:23')).toBe(83);
    expect(parseEtaToSeconds('10:00')).toBe(600);
    expect(parseEtaToSeconds('01:23:45')).toBe(5025);
    expect(parseEtaToSeconds('100:00:00')).toBe(360000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseEtaToSeconds('  00:30  ')).toBe(30);
  });

  it('returns undefined for non-time values', () => {
    expect(parseEtaToSeconds('Unknown')).toBeUndefined();
    expect(parseEtaToSeconds('NA')).toBeUndefined();
    expect(parseEtaToSeconds('garbage')).toBeUndefined();
    expect(parseEtaToSeconds(undefined)).toBeUndefined();
    expect(parseEtaToSeconds('')).toBeUndefined();
    expect(parseEtaToSeconds('1:23')).toBeUndefined(); // requires zero-padded
  });
});

describe('formatSecondsToEta', () => {
  it('formats MM:SS for under one hour', () => {
    expect(formatSecondsToEta(0)).toBe('00:00');
    expect(formatSecondsToEta(45)).toBe('00:45');
    expect(formatSecondsToEta(125)).toBe('02:05');
    expect(formatSecondsToEta(3599)).toBe('59:59');
  });

  it('formats HH:MM:SS for one hour and beyond', () => {
    expect(formatSecondsToEta(3600)).toBe('01:00:00');
    expect(formatSecondsToEta(5025)).toBe('01:23:45');
  });

  it('rounds fractional seconds', () => {
    expect(formatSecondsToEta(30.7)).toBe('00:31');
    expect(formatSecondsToEta(0.49)).toBe('00:00');
  });

  it('returns em-dash for invalid input', () => {
    expect(formatSecondsToEta(Number.NaN)).toBe('—');
    expect(formatSecondsToEta(-1)).toBe('—');
    expect(formatSecondsToEta(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('createProgressSmoother', () => {
  it('bootstraps published value from the first parseable sample', () => {
    const t = 0;
    const smoother = createProgressSmoother(() => t);

    expect(smoother.current()).toEqual({ speed: undefined, eta: undefined });

    // 5.00 MiB/s binary == 5,242,880 bytes/s == 5.2 MB/s in SI (1 decimal place).
    smoother.sample('5.00MiB/s', '00:30');
    expect(smoother.current()).toEqual({ speed: '5.2 MB/s', eta: '00:30' });
  });

  it('does NOT publish on every sample within a single 2-second window', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    smoother.sample('5.00MiB/s', '00:30'); // bootstrap → "5.2 MB/s"
    t = 500;
    smoother.sample('10.00MiB/s', '00:25'); // mid-window, no publish
    t = 1500;
    smoother.sample('15.00MiB/s', '00:20'); // still mid-window

    expect(smoother.current()).toEqual({ speed: '5.2 MB/s', eta: '00:30' });
  });

  it('publishes window-mean speed + EMA-smoothed ETA when the 2 s window elapses', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    // Each sample contributes (1 - α) = 0.1 to the EMA. Starting at 30 s,
    // sustained 20 s ETAs slowly decay the running estimate.
    smoother.sample('5.00MiB/s', '00:30'); // bootstrap eta=30
    t = 500;
    smoother.sample('10.00MiB/s', '00:25'); // ema = 0.9*30 + 0.1*25 = 29.5
    t = 1500;
    smoother.sample('15.00MiB/s', '00:20'); // ema = 0.9*29.5 + 0.1*20 = 28.55
    t = 2000;
    smoother.sample('20.00MiB/s', '00:15'); // ema = 0.9*28.55 + 0.1*15 = 27.195, ticks

    // Mean of [5, 10, 15, 20] MiB/s = 12.5 MiB/s = ~13.1 MB/s in SI.
    expect(smoother.current().speed).toBe('13.1 MB/s');
    // EMA-smoothed ETA, rounded to seconds → 27. NOT the latest raw 15.
    expect(smoother.current().eta).toBe('00:27');
  });

  it('EMA-smooths transient ETA spikes', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    // Steady-state at 30 s.
    smoother.sample('5.00MiB/s', '00:30'); // bootstrap
    t = 500;
    smoother.sample('5.00MiB/s', '00:30'); // ema stays 30
    t = 1000;
    smoother.sample('5.00MiB/s', '00:30');

    // One outlier sample (yt-dlp burst computation): 5 min remaining.
    t = 1500;
    smoother.sample('5.00MiB/s', '05:00'); // ema = 0.9*30 + 0.1*300 = 57

    // Cross the tick.
    t = 2000;
    smoother.sample('5.00MiB/s', '00:30'); // ema = 0.9*57 + 0.1*30 = 54.3, ticks

    // The outlier got damped to ~54 s, not the raw 300 s it represented.
    expect(smoother.current().eta).toBe('00:54');
  });

  it('starts a fresh speed window after each tick (EMA persists across ticks)', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    smoother.sample('5.00MiB/s', '00:30');
    t = 2000;
    smoother.sample('15.00MiB/s', '00:20'); // ticks → publishes mean of [5,15] MiB/s
    expect(smoother.current().speed).toBe('10.5 MB/s');

    // New speed window. Speed samples reset; EMA-ETA carries across.
    t = 2500;
    smoother.sample('20.00MiB/s', '00:10');
    t = 4000;
    smoother.sample('30.00MiB/s', '00:05'); // ticks → publishes mean of [20, 30] MiB/s
    expect(smoother.current().speed).toBe('26.2 MB/s');
    // EMA-smoothed across all five samples — much higher than the latest raw 5 s.
    const etaSeconds = parseEtaToSeconds(smoother.current().eta);
    expect(etaSeconds).toBeGreaterThan(15);
    expect(etaSeconds).toBeLessThan(30);
  });

  it('ignores unparseable speeds but still smooths ETA', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    smoother.sample('Unknown B/s', '00:30'); // no speed bootstrap, ETA bootstrap = 30
    expect(smoother.current()).toEqual({ speed: undefined, eta: '00:30' });

    t = 2000;
    smoother.sample('Unknown B/s', '00:20'); // ticks; ema = 0.9*30 + 0.1*20 = 29
    expect(smoother.current()).toEqual({ speed: undefined, eta: '00:29' });
  });

  it('survives the "now" function returning the same value (zero-duration window)', () => {
    const smoother = createProgressSmoother(() => 1000);
    smoother.sample('5.00MiB/s', '00:30');
    smoother.sample('10.00MiB/s', '00:20');
    smoother.sample('15.00MiB/s', '00:10');
    // No tick has fired because elapsed is always 0. Published stays at the
    // bootstrap values (first parseable sample wins).
    expect(smoother.current()).toEqual({ speed: '5.2 MB/s', eta: '00:30' });
  });

  it('uses Date.now by default when no clock is provided', () => {
    // Sanity: factory works without injection.
    const smoother = createProgressSmoother();
    smoother.sample('5.00MiB/s', '00:30');
    expect(smoother.current().speed).toBe('5.2 MB/s');
    // Avoid an unused import warning.
    expect(vi).toBeDefined();
  });
});
