import { describe, expect, it } from 'vitest';
import { generateDownloadId } from './ipc';

describe('generateDownloadId', () => {
  const FIXED_NOW = new Date('2026-05-16T20:45:30');

  it('uses the YouTube ?v= param as the slug', () => {
    const id = generateDownloadId('https://www.youtube.com/watch?v=jNQXAC9IVRw', FIXED_NOW);
    expect(id).toBe(`youtube-jNQXAC9IVRw-20260516-204530-${id.split('-').at(-1)}`);
    expect(id).toMatch(/^youtube-jNQXAC9IVRw-20260516-204530-[a-z0-9]{1,6}$/);
  });

  it('uses the last path segment when no ?v= is present (Vimeo, Zoom)', () => {
    expect(generateDownloadId('https://vimeo.com/12345', FIXED_NOW)).toMatch(
      /^vimeo-12345-20260516-204530-[a-z0-9]{1,6}$/,
    );
    expect(generateDownloadId('https://zoom.us/rec/play/abc123', FIXED_NOW)).toMatch(
      /^zoom-abc123-20260516-204530-[a-z0-9]{1,6}$/,
    );
  });

  it('strips a leading www. from the hostname', () => {
    expect(generateDownloadId('https://www.vimeo.com/999', FIXED_NOW)).toMatch(/^vimeo-999-/);
  });

  it('sanitizes filesystem-unsafe characters and clips long segments', () => {
    const id = generateDownloadId(
      'https://example.com/very/deep/path/with-some_weird@chars.and!stuff.mp4',
      FIXED_NOW,
    );
    expect(id).toMatch(/^example-/);
    expect(id).not.toMatch(/[!@]/);
    const slug = id.split('-20260516')[0] ?? '';
    expect(slug.length).toBeLessThanOrEqual(30 + 'example-'.length);
  });

  it('falls back to "download" for malformed URLs', () => {
    expect(generateDownloadId('not a url', FIXED_NOW)).toMatch(
      /^download-20260516-204530-[a-z0-9]{1,6}$/,
    );
    expect(generateDownloadId('', FIXED_NOW)).toMatch(/^download-/);
  });

  it('falls back to just the hostname for URLs with no path or query', () => {
    expect(generateDownloadId('https://youtube.com/', FIXED_NOW)).toMatch(
      /^youtube-20260516-204530-[a-z0-9]{1,6}$/,
    );
  });

  it('produces distinct ids across rapid successive calls (same URL, same second)', () => {
    // 64 in a tight loop. The random 6-char base-36 tail is the only thing
    // that varies; collisions would still be extremely unlikely but verify.
    const ids = new Set(
      Array.from({ length: 64 }, () =>
        generateDownloadId('https://youtube.com/watch?v=jNQXAC9IVRw', FIXED_NOW),
      ),
    );
    expect(ids.size).toBe(64);
  });

  it('embeds the actual current time when no Date is passed', () => {
    const before = Date.now();
    const id = generateDownloadId('https://youtube.com/watch?v=x');
    const after = Date.now();
    const stampMatch = id.match(/-(\d{8})-(\d{6})-/);
    expect(stampMatch).not.toBeNull();
    if (stampMatch) {
      const [, ymd, hms] = stampMatch;
      const y = Number(ymd?.slice(0, 4));
      const mo = Number(ymd?.slice(4, 6)) - 1;
      const d = Number(ymd?.slice(6, 8));
      const h = Number(hms?.slice(0, 2));
      const mi = Number(hms?.slice(2, 4));
      const s = Number(hms?.slice(4, 6));
      const parsed = new Date(y, mo, d, h, mi, s).getTime();
      expect(parsed).toBeGreaterThanOrEqual(before - 1000);
      expect(parsed).toBeLessThanOrEqual(after + 1000);
    }
  });
});
