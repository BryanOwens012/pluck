import { describe, expect, it } from 'vitest';
import {
  isCookieAccessDeniedError,
  isPasswordRequiredError,
  parseMetadata,
  parsePlaylistContextFromFlat,
  parsePlaylistEntries,
  parseProgressLine,
} from './parser';

describe('parseProgressLine', () => {
  it('parses a typical downloading line', () => {
    const line = '{"status":"downloading","percent":" 42.3%","speed":"1.23MiB/s","eta":"00:05"}';
    expect(parseProgressLine(line)).toEqual({
      status: 'downloading',
      percent: 42.3,
      speed: '1.23MiB/s',
      eta: '00:05',
    });
  });

  it('parses a 100% finished line', () => {
    const line = '{"status":"finished","percent":"100%","speed":"500KiB/s","eta":"00:00"}';
    expect(parseProgressLine(line)).toEqual({
      status: 'finished',
      percent: 100,
      speed: '500KiB/s',
      eta: '00:00',
    });
  });

  it('treats "Unknown" / "N/A" / empty as undefined for speed and eta', () => {
    const line = '{"status":"downloading","percent":" 10%","speed":"Unknown","eta":"N/A"}';
    expect(parseProgressLine(line)).toEqual({
      status: 'downloading',
      percent: 10,
      speed: undefined,
      eta: undefined,
    });
  });

  it('returns NaN percent when yt-dlp emits an unparseable value', () => {
    // yt-dlp emits "N/A" for percent when total bytes are unknown (e.g. live stream).
    const line = '{"status":"downloading","percent":"N/A","speed":"500KiB/s","eta":"00:10"}';
    const event = parseProgressLine(line);
    expect(event?.status).toBe('downloading');
    expect(event?.percent).toBeNaN();
  });

  it('returns null for non-JSON noise lines from yt-dlp', () => {
    expect(parseProgressLine('[youtube] Extracting URL: https://youtube.com/...')).toBeNull();
    expect(parseProgressLine('[download] Destination: video.mp4')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
    expect(parseProgressLine('   ')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseProgressLine('{not json}')).toBeNull();
    expect(parseProgressLine('{"status":"downloading"')).toBeNull();
  });

  it('returns null for JSON lacking a recognized status', () => {
    expect(parseProgressLine('{"status":"preparing","percent":"0%"}')).toBeNull();
    expect(parseProgressLine('{"percent":"50%"}')).toBeNull();
  });

  it('handles surrounding whitespace', () => {
    const line = '  {"status":"downloading","percent":"5%","speed":"1MiB/s","eta":"01:00"}  ';
    expect(parseProgressLine(line)?.percent).toBe(5);
  });
});

describe('parseMetadata', () => {
  it('projects the subset of fields we consume', () => {
    const json = JSON.stringify({
      id: 'abc123',
      title: 'Some Video',
      extractor: 'youtube',
      duration: 327.5,
      uploader: 'Some Channel',
      thumbnail: 'https://example.com/thumb.jpg',
      formats: [
        /* yt-dlp ships a huge array; verify we ignore it */
      ],
      description: 'long description text',
    });
    expect(parseMetadata(json)).toEqual({
      id: 'abc123',
      title: 'Some Video',
      extractor: 'youtube',
      durationSec: 327.5,
      uploader: 'Some Channel',
      thumbnailUrl: 'https://example.com/thumb.jpg',
      formats: [],
    });
  });

  it('omits optional fields when absent', () => {
    const json = JSON.stringify({ id: 'x', title: 't', extractor: 'generic' });
    expect(parseMetadata(json)).toEqual({
      id: 'x',
      title: 't',
      extractor: 'generic',
      durationSec: undefined,
      uploader: undefined,
      thumbnailUrl: undefined,
      formats: [],
    });
  });

  it('extracts the formats array when yt-dlp provides one', () => {
    const json = JSON.stringify({
      id: 'x',
      title: 't',
      extractor: 'youtube',
      formats: [
        {
          ext: 'mp4',
          vcodec: 'avc1.640028',
          acodec: 'mp4a.40.2',
          width: 1920,
          height: 1080,
          fps: 30,
          tbr: 2500,
        },
        {
          ext: 'webm',
          vcodec: 'vp9',
          acodec: 'opus',
          width: 3840,
          height: 2160,
          fps: 60,
          tbr: 8000,
        },
      ],
    });
    const meta = parseMetadata(json);
    expect(meta.formats).toHaveLength(2);
    expect(meta.formats[0]?.ext).toBe('mp4');
    expect(meta.formats[1]?.height).toBe(2160);
  });

  it('drops malformed format entries (missing required fields) without throwing', () => {
    // yt-dlp occasionally emits half-built entries during extractor
    // edge cases. They should be skipped, not crash the parser.
    const json = JSON.stringify({
      id: 'x',
      title: 't',
      extractor: 'youtube',
      formats: [
        { ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 720 }, // valid
        { ext: 'webm' }, // missing vcodec + acodec — dropped
        null, // garbage — dropped
        { vcodec: 'vp9', acodec: 'opus' }, // missing ext — dropped
      ],
    });
    expect(parseMetadata(json).formats).toHaveLength(1);
  });

  it('renames yt-dlp `thumbnail` field to `thumbnailUrl` in the output', () => {
    const json = JSON.stringify({
      id: 'x',
      title: 't',
      extractor: 'e',
      thumbnail: 'https://i.ytimg.com/vi/x/hqdefault.jpg',
    });
    const result = parseMetadata(json);
    expect(result.thumbnailUrl).toBe('https://i.ytimg.com/vi/x/hqdefault.jpg');
    expect((result as unknown as { thumbnail?: string }).thumbnail).toBeUndefined();
  });

  it('drops non-string thumbnail values silently', () => {
    const json = JSON.stringify({ id: 'x', title: 't', extractor: 'e', thumbnail: 42 });
    expect(parseMetadata(json).thumbnailUrl).toBeUndefined();
  });

  it('throws when required fields are missing', () => {
    expect(() => parseMetadata(JSON.stringify({ id: 'x', title: 't' }))).toThrow(
      /missing required fields/,
    );
    expect(() => parseMetadata(JSON.stringify({ title: 't', extractor: 'e' }))).toThrow();
    expect(() => parseMetadata(JSON.stringify({ id: 'x', extractor: 'e' }))).toThrow();
  });

  it('throws on malformed JSON', () => {
    expect(() => parseMetadata('not json')).toThrow();
    expect(() => parseMetadata('{"id":')).toThrow();
  });

  it('rejects wrong-type required fields', () => {
    expect(() => parseMetadata(JSON.stringify({ id: 123, title: 't', extractor: 'e' }))).toThrow(
      /missing required fields/,
    );
    expect(() => parseMetadata(JSON.stringify({ id: 'x', title: null, extractor: 'e' }))).toThrow(
      /missing required fields/,
    );
  });
});

describe('isPasswordRequiredError', () => {
  it('matches typical Zoom password errors', () => {
    expect(
      isPasswordRequiredError('ERROR: [Zoom] abc123: This recording requires a password to view'),
    ).toBe(true);
    expect(
      isPasswordRequiredError(
        'ERROR: [Zoom] xyz: video requires authentication; pass --video-password',
      ),
    ).toBe(true);
  });

  it('matches Zoom passcode wording (newer Zoom UI uses "passcode" not "password")', () => {
    expect(
      isPasswordRequiredError('ERROR: [Zoom] xyz: This recording is protected with a passcode'),
    ).toBe(true);
  });

  it('matches "Authentication required" word order (regression for narrow regex)', () => {
    expect(
      isPasswordRequiredError('ERROR: [Zoom] xyz: Authentication required for this recording'),
    ).toBe(true);
  });

  it('matches when "Zoom" appears anywhere in the line, including extractor key form', () => {
    expect(isPasswordRequiredError('zoom: ERROR: Password required for recording xyz')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isPasswordRequiredError('ERROR: [youtube] Video unavailable')).toBe(false);
    expect(isPasswordRequiredError('ERROR: HTTP Error 403: Forbidden (no password mention)')).toBe(
      false,
    );
  });

  it('does not match password mentions outside Zoom context', () => {
    // A site with "password" in its name shouldn't false-positive without a Zoom signal.
    expect(isPasswordRequiredError('ERROR: [passwordprotect.tv] forbidden')).toBe(false);
    // Generic auth errors without Zoom keyword.
    expect(isPasswordRequiredError('ERROR: [vimeo] Authentication required')).toBe(false);
  });

  it('handles empty / whitespace input', () => {
    expect(isPasswordRequiredError('')).toBe(false);
    expect(isPasswordRequiredError('   \n  ')).toBe(false);
  });
});

describe('isCookieAccessDeniedError', () => {
  it('matches Chromium-family Keychain denial wording', () => {
    // Common yt-dlp output when the macOS Keychain prompt is denied.
    expect(
      isCookieAccessDeniedError('WARNING: failed to decrypt cookie; access to keychain was denied'),
    ).toBe(true);
    expect(isCookieAccessDeniedError('ERROR: could not decrypt cookies from Chrome')).toBe(true);
    expect(
      isCookieAccessDeniedError(
        'WARNING: Failed to access keyring; the user cancelled the operation',
      ),
    ).toBe(true);
  });

  it('matches Safari permission-denied wording (no Full Disk Access)', () => {
    expect(
      isCookieAccessDeniedError(
        "ERROR: Permission denied: '/Users/x/Library/Cookies/Cookies.binarycookies'",
      ),
    ).toBe(true);
    expect(isCookieAccessDeniedError('ERROR: cookie file: permission denied')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isCookieAccessDeniedError('ERROR: HTTP 404')).toBe(false);
    expect(isCookieAccessDeniedError('ERROR: [youtube] Video unavailable')).toBe(false);
    expect(isCookieAccessDeniedError('ERROR: Video is age-restricted')).toBe(false);
    // Cookie WITHOUT denial signal → not a denial.
    expect(isCookieAccessDeniedError('Loaded 42 cookies from chrome')).toBe(false);
    // Denial signal WITHOUT cookie context → unrelated permission error.
    expect(isCookieAccessDeniedError('ERROR: permission denied: /etc/foo')).toBe(false);
  });

  it('handles empty / whitespace input', () => {
    expect(isCookieAccessDeniedError('')).toBe(false);
    expect(isCookieAccessDeniedError('   \n  ')).toBe(false);
  });
});

// ---- playlist context on parseMetadata --------------------------------

describe('parseMetadata playlist handling', () => {
  it('returns playlistContext for a video-in-playlist record', () => {
    // yt-dlp on `watch?v=X&list=Y` emits a video shape with extra
    // playlist_* fields. We project them into `playlistContext` and
    // mark `isExplicitPlaylistUrl: false` because the URL was a video
    // URL that happened to carry playlist context.
    const json = JSON.stringify({
      id: 'vid-x',
      title: 'Episode 3',
      extractor: 'youtube',
      duration: 600,
      playlist_id: 'PLxxx',
      playlist_title: 'My Series',
      playlist_count: 12,
    });
    const meta = parseMetadata(json);
    expect(meta.playlistContext).toEqual({
      id: 'PLxxx',
      title: 'My Series',
      entryCount: 12,
      isExplicitPlaylistUrl: false,
    });
  });

  it('returns playlistContext for an explicit playlist URL (_type: playlist)', () => {
    // `playlist?list=Y` URLs return a `_type: 'playlist'` shape with
    // an entries array. parseMetadata synthesizes a uniform video
    // record from the first entry, with isExplicitPlaylistUrl: true.
    const json = JSON.stringify({
      _type: 'playlist',
      id: 'PLxxx',
      title: 'JS Conf 2024',
      extractor: 'youtube:playlist',
      playlist_count: 47,
      entries: [
        { id: 'first-vid', title: 'Opening Keynote', duration: 1800 },
        { id: 'second-vid', title: 'State of the Language', duration: 2400 },
      ],
    });
    const meta = parseMetadata(json);
    expect(meta.title).toBe('Opening Keynote');
    expect(meta.id).toBe('first-vid');
    expect(meta.playlistContext).toEqual({
      id: 'PLxxx',
      title: 'JS Conf 2024',
      entryCount: 47,
      isExplicitPlaylistUrl: true,
    });
  });

  it('returns undefined playlistContext for a plain single video', () => {
    const json = JSON.stringify({
      id: 'vid-x',
      title: 'A standalone video',
      extractor: 'youtube',
    });
    expect(parseMetadata(json).playlistContext).toBeUndefined();
  });

  it('falls back entryCount to entries.length when playlist_count is missing', () => {
    const json = JSON.stringify({
      _type: 'playlist',
      id: 'PLxxx',
      title: 'No Count Playlist',
      extractor: 'youtube:playlist',
      entries: [
        { id: 'a', title: 'A', url: 'https://x/a' },
        { id: 'b', title: 'B', url: 'https://x/b' },
        { id: 'c', title: 'C', url: 'https://x/c' },
      ],
    });
    expect(parseMetadata(json).playlistContext?.entryCount).toBe(3);
  });
});

// ---- parsePlaylistEntries -----------------------------------------------

describe('parsePlaylistEntries', () => {
  it('returns one PlaylistEntry per entry, preserving order', () => {
    const json = JSON.stringify({
      _type: 'playlist',
      id: 'PLxxx',
      title: 'A',
      entries: [
        { url: 'https://x/1', title: 'One', duration: 100, playlist_index: 1 },
        { url: 'https://x/2', title: 'Two', duration: 200, playlist_index: 2 },
        { url: 'https://x/3', title: 'Three', duration: 300, playlist_index: 3 },
      ],
    });
    expect(parsePlaylistEntries(json)).toEqual([
      { url: 'https://x/1', title: 'One', durationSec: 100, index: 1 },
      { url: 'https://x/2', title: 'Two', durationSec: 200, index: 2 },
      { url: 'https://x/3', title: 'Three', durationSec: 300, index: 3 },
    ]);
  });

  it('returns [] for a non-playlist record (single video)', () => {
    const json = JSON.stringify({ id: 'x', title: 't', extractor: 'youtube' });
    expect(parsePlaylistEntries(json)).toEqual([]);
  });

  it('skips entries missing url or title (yt-dlp half-built records for unavailable videos)', () => {
    const json = JSON.stringify({
      _type: 'playlist',
      id: 'PLxxx',
      title: 'A',
      entries: [
        { url: 'https://x/1', title: 'One' },
        { id: 'broken' /* no url, no title */ },
        null, // entirely missing
        { url: 'https://x/2', title: 'Two' },
      ],
    });
    expect(parsePlaylistEntries(json)).toHaveLength(2);
  });

  it('falls back to array index (1-based) when entry lacks playlist_index', () => {
    const json = JSON.stringify({
      _type: 'playlist',
      id: 'PLxxx',
      title: 'A',
      entries: [
        { url: 'https://x/1', title: 'One' },
        { url: 'https://x/2', title: 'Two' },
      ],
    });
    const entries = parsePlaylistEntries(json);
    expect(entries[0]?.index).toBe(1);
    expect(entries[1]?.index).toBe(2);
  });
});

// ---- parsePlaylistContextFromFlat ---------------------------------------

describe('parsePlaylistContextFromFlat', () => {
  it('extracts id + title + count from a flat-playlist record', () => {
    const json = JSON.stringify({
      _type: 'playlist',
      id: 'PLxxx',
      title: 'My Series',
      playlist_count: 12,
      entries: [],
    });
    expect(parsePlaylistContextFromFlat(json)).toEqual({
      id: 'PLxxx',
      title: 'My Series',
      entryCount: 12,
      isExplicitPlaylistUrl: true,
    });
  });

  it('falls back entryCount to entries.length when playlist_count is missing', () => {
    const json = JSON.stringify({
      _type: 'playlist',
      id: 'PLxxx',
      title: 'My Series',
      entries: [
        { url: 'a', title: 'A' },
        { url: 'b', title: 'B' },
      ],
    });
    expect(parsePlaylistContextFromFlat(json)?.entryCount).toBe(2);
  });

  it('returns undefined for non-playlist records', () => {
    expect(parsePlaylistContextFromFlat(JSON.stringify({ id: 'x', title: 't' }))).toBeUndefined();
  });
});
