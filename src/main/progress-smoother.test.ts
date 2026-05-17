import { describe, expect, it, vi } from 'vitest';
import {
  createProgressSmoother,
  formatBytesPerSec,
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
  it('picks the largest unit that keeps the value readable', () => {
    expect(formatBytesPerSec(800)).toBe('800 B/s');
    expect(formatBytesPerSec(2048)).toBe('2.00 KiB/s');
    expect(formatBytesPerSec(5 * 1024 * 1024)).toBe('5.00 MiB/s');
    expect(formatBytesPerSec(3 * 1024 * 1024 * 1024)).toBe('3.00 GiB/s');
  });

  it('returns em-dash for invalid input', () => {
    expect(formatBytesPerSec(Number.NaN)).toBe('—');
    expect(formatBytesPerSec(-1)).toBe('—');
    expect(formatBytesPerSec(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('createProgressSmoother', () => {
  it('bootstraps published value from the first parseable sample', () => {
    const t = 0;
    const smoother = createProgressSmoother(() => t);

    expect(smoother.current()).toEqual({ speed: undefined, eta: undefined });

    smoother.sample('5.00MiB/s', '00:30');
    expect(smoother.current()).toEqual({ speed: '5.00 MiB/s', eta: '00:30' });
  });

  it('does NOT publish on every sample within a single 2-second window', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    smoother.sample('5.00MiB/s', '00:30'); // bootstrap → "5.00 MiB/s"
    t = 500;
    smoother.sample('10.00MiB/s', '00:25'); // mid-window, no publish
    t = 1500;
    smoother.sample('15.00MiB/s', '00:20'); // still mid-window

    expect(smoother.current()).toEqual({ speed: '5.00 MiB/s', eta: '00:30' });
  });

  it('publishes window mean + latest ETA when the 2-second window elapses', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    smoother.sample('5.00MiB/s', '00:30');
    t = 500;
    smoother.sample('10.00MiB/s', '00:25');
    t = 1500;
    smoother.sample('15.00MiB/s', '00:20');

    // The fourth sample crosses the 2 s boundary and triggers the tick.
    t = 2000;
    smoother.sample('20.00MiB/s', '00:15');

    // Mean of [5, 10, 15, 20] = 12.5 MiB/s.
    expect(smoother.current().speed).toBe('12.50 MiB/s');
    // ETA is always the most recent value, never averaged.
    expect(smoother.current().eta).toBe('00:15');
  });

  it('starts a fresh window after each tick', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    smoother.sample('5.00MiB/s', '00:30');
    t = 2000;
    smoother.sample('15.00MiB/s', '00:20'); // ticks → publishes mean of [5,15] = 10
    expect(smoother.current().speed).toBe('10.00 MiB/s');

    // New window starts here. Samples in this window should be averaged
    // independently of the previous window's samples.
    t = 2500;
    smoother.sample('20.00MiB/s', '00:10');
    t = 4000;
    smoother.sample('30.00MiB/s', '00:05'); // ticks → publishes mean of [20, 30] = 25
    expect(smoother.current().speed).toBe('25.00 MiB/s');
    expect(smoother.current().eta).toBe('00:05');
  });

  it('ignores unparseable speeds but still updates ETA on tick', () => {
    let t = 0;
    const smoother = createProgressSmoother(() => t);

    smoother.sample('Unknown B/s', '00:30'); // no bootstrap (unparseable)
    expect(smoother.current()).toEqual({ speed: undefined, eta: undefined });

    t = 2000;
    smoother.sample('Unknown B/s', '00:25'); // ticks, but no speed samples → ETA-only update
    expect(smoother.current()).toEqual({ speed: undefined, eta: '00:25' });
  });

  it('survives the "now" function returning the same value (zero-duration window)', () => {
    const smoother = createProgressSmoother(() => 1000);
    smoother.sample('5.00MiB/s', '00:30');
    smoother.sample('10.00MiB/s', '00:20');
    smoother.sample('15.00MiB/s', '00:10');
    // No tick has fired because elapsed is always 0. Published stays at bootstrap.
    expect(smoother.current()).toEqual({ speed: '5.00 MiB/s', eta: '00:30' });
  });

  it('uses Date.now by default when no clock is provided', () => {
    // Sanity: factory works without injection.
    const smoother = createProgressSmoother();
    smoother.sample('5.00MiB/s', '00:30');
    expect(smoother.current().speed).toBe('5.00 MiB/s');
    // Avoid an unused import warning.
    expect(vi).toBeDefined();
  });
});
