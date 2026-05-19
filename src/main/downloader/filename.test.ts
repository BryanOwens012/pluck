import { describe, expect, it } from 'vitest';
import { buildFinalFilename, buildPlaylistFolderName } from './filename';

// Fixed clock for tests that hit the today-date fallback path.
const FIXED_NOW = new Date('2026-05-19T15:30:00Z');

describe('buildFinalFilename - single-video pattern', () => {
  it('renders `<Uploader> - <Title> (YYYY-MM-DD).<ext>` with upload date', () => {
    expect(
      buildFinalFilename({
        title: 'How Bitcoin Works',
        videoId: 'abc123',
        uploader: 'Coinbase',
        uploadDate: '20251002',
        ext: 'mp4',
      }),
    ).toBe('Coinbase - How Bitcoin Works (2025-10-02).mp4');
  });

  it('falls back to today when uploadDate is missing', () => {
    expect(
      buildFinalFilename(
        {
          title: 'Live Now',
          videoId: 'live1',
          uploader: 'NewsCo',
          ext: 'mp4',
        },
        FIXED_NOW,
      ),
    ).toBe('NewsCo - Live Now (2026-05-19).mp4');
  });

  it('falls back to today when uploadDate is malformed (not 8 digits)', () => {
    expect(
      buildFinalFilename(
        {
          title: 'T',
          videoId: 'x',
          uploader: 'U',
          uploadDate: '2025-10-02',
          ext: 'mp4',
        },
        FIXED_NOW,
      ),
    ).toBe('U - T (2026-05-19).mp4');
  });

  it('drops the `<Uploader> - ` prefix when uploader is undefined', () => {
    expect(
      buildFinalFilename({
        title: 'Standalone',
        videoId: 'x',
        uploadDate: '20251002',
        ext: 'mp4',
      }),
    ).toBe('Standalone (2025-10-02).mp4');
  });

  it('drops the `<Uploader> - ` prefix when uploader sanitizes to empty', () => {
    // All-whitespace uploader → empty after sanitize → no dash orphan.
    expect(
      buildFinalFilename({
        title: 'Standalone',
        videoId: 'x',
        uploader: '   ',
        uploadDate: '20251002',
        ext: 'mp4',
      }),
    ).toBe('Standalone (2025-10-02).mp4');
  });
});

describe('buildFinalFilename - playlist pattern', () => {
  it('prepends a zero-padded index sized to the playlist width', () => {
    expect(
      buildFinalFilename({
        title: 'Episode One',
        videoId: 'e1',
        uploader: 'Channel',
        uploadDate: '20250112',
        ext: 'mp4',
        playlistIndex: 1,
        playlistTotal: 47,
      }),
    ).toBe('01 Channel - Episode One (2025-01-12).mp4');
  });

  it('uses 3-digit width for 200-entry playlists', () => {
    expect(
      buildFinalFilename({
        title: 'Episode Three',
        videoId: 'e3',
        uploader: 'Channel',
        uploadDate: '20250115',
        ext: 'mp4',
        playlistIndex: 3,
        playlistTotal: 200,
      }),
    ).toBe('003 Channel - Episode Three (2025-01-15).mp4');
  });

  it('uses 1-digit width for ≤9-entry playlists', () => {
    expect(
      buildFinalFilename({
        title: 'Short',
        videoId: 'short',
        uploader: 'Ch',
        uploadDate: '20250101',
        ext: 'mp4',
        playlistIndex: 2,
        playlistTotal: 5,
      }),
    ).toBe('2 Ch - Short (2025-01-01).mp4');
  });

  it('falls back to the index width when playlistTotal is undefined', () => {
    // `12` → 2 digits → "12" (already padded to its own width).
    expect(
      buildFinalFilename({
        title: 'T',
        videoId: 'x',
        uploader: 'U',
        uploadDate: '20250101',
        ext: 'mp4',
        playlistIndex: 12,
      }),
    ).toBe('12 U - T (2025-01-01).mp4');
  });

  it('skips the index prefix when playlistIndex is undefined (single-video)', () => {
    expect(
      buildFinalFilename({
        title: 'T',
        videoId: 'x',
        uploader: 'U',
        uploadDate: '20250101',
        ext: 'mp4',
        playlistTotal: 47, // present but ignored without an index
      }),
    ).toBe('U - T (2025-01-01).mp4');
  });
});

describe('buildFinalFilename - sanitization', () => {
  it('replaces path separators with a single space and collapses runs', () => {
    expect(
      buildFinalFilename({
        title: 'A/B\\C: Title',
        videoId: 'x',
        uploadDate: '20250101',
        ext: 'mp4',
      }),
    ).toBe('A B C Title (2025-01-01).mp4');
  });

  it('strips quotes, brackets, pipes, asterisks, question marks', () => {
    expect(
      buildFinalFilename({
        title: 'Why "this" <is> *cool*?|',
        videoId: 'x',
        uploadDate: '20250101',
        ext: 'mp4',
      }),
    ).toBe('Why this is cool (2025-01-01).mp4');
  });

  it('strips control characters (\\n, \\r, \\t, \\0)', () => {
    expect(
      buildFinalFilename({
        title: 'Line\nBreak\tTab\0Null',
        videoId: 'x',
        uploadDate: '20250101',
        ext: 'mp4',
      }),
    ).toBe('Line Break Tab Null (2025-01-01).mp4');
  });

  it('trims leading/trailing whitespace AND dots (Windows trailing-dot quirk)', () => {
    expect(
      buildFinalFilename({
        title: '  ...Title...  ',
        videoId: 'x',
        uploadDate: '20250101',
        ext: 'mp4',
      }),
    ).toBe('Title (2025-01-01).mp4');
  });

  it('falls back to videoId when the title sanitizes to empty', () => {
    expect(
      buildFinalFilename({
        title: '////',
        videoId: 'fallback-id',
        uploadDate: '20250101',
        ext: 'mp4',
      }),
    ).toBe('fallback-id (2025-01-01).mp4');
  });

  it('falls back to "untitled" when both title and videoId sanitize to empty', () => {
    expect(
      buildFinalFilename({
        title: '   ',
        videoId: '   ',
        uploadDate: '20250101',
        ext: 'mp4',
      }),
    ).toBe('untitled (2025-01-01).mp4');
  });

  it('caps very long titles around 200 chars to keep filesystem-friendly', () => {
    const longTitle = 'A'.repeat(500);
    const result = buildFinalFilename({
      title: longTitle,
      videoId: 'x',
      uploadDate: '20250101',
      ext: 'mp4',
    });
    // Should fit in ~200 chars of stem + the ` (YYYY-MM-DD).mp4` tail.
    // We just guard against the >300 case slipping through.
    expect(result.length).toBeLessThan(260);
    expect(result.endsWith('.mp4')).toBe(true);
  });

  it('handles a sanitized extension defensively (no dot doubling)', () => {
    expect(
      buildFinalFilename({
        title: 'T',
        videoId: 'x',
        uploadDate: '20250101',
        ext: 'm4a',
      }),
    ).toBe('T (2025-01-01).m4a');
  });
});

describe('buildPlaylistFolderName', () => {
  it('returns the sanitized playlist title when present', () => {
    expect(
      buildPlaylistFolderName({ playlistTitle: 'Coinbase Trading', playlistId: 'PLxxx' }),
    ).toBe('Coinbase Trading');
  });

  it('sanitizes path separators / banned chars in the title', () => {
    expect(
      buildPlaylistFolderName({
        playlistTitle: 'My/Crypto: Series 2025',
        playlistId: 'PLxxx',
      }),
    ).toBe('My Crypto Series 2025');
  });

  it('falls back to the playlist id when title is undefined', () => {
    expect(buildPlaylistFolderName({ playlistId: 'PLxxx' })).toBe('PLxxx');
  });

  it('falls back to the playlist id when title sanitizes to empty', () => {
    expect(buildPlaylistFolderName({ playlistTitle: '   ', playlistId: 'PLxxx' })).toBe('PLxxx');
  });

  it('falls back to "playlist" if both title and id sanitize to empty (defensive)', () => {
    expect(buildPlaylistFolderName({ playlistTitle: '   ', playlistId: '/' })).toBe('playlist');
  });
});
