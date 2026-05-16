import { describe, expect, it } from 'vitest';
import { isPasswordRequiredError, parseMetadata, parseProgressLine } from './parser';

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
      thumbnail: 'https://example.com/thumb.jpg',
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
      thumbnail: undefined,
    });
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

  it('does not match unrelated errors', () => {
    expect(isPasswordRequiredError('ERROR: [youtube] Video unavailable')).toBe(false);
    expect(isPasswordRequiredError('ERROR: HTTP Error 403: Forbidden (no password mention)')).toBe(
      false,
    );
  });

  it('does not match generic "password" mentions outside Zoom context', () => {
    // A site with "password" in its name shouldn't false-positive without a Zoom signal.
    expect(isPasswordRequiredError('ERROR: [passwordprotect.tv] forbidden')).toBe(false);
  });
});
