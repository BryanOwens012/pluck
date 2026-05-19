import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './normalize';

describe('normalizeUrl', () => {
  it('leaves an already-https URL unchanged', () => {
    expect(normalizeUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBe(
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    );
  });

  it('leaves an already-http URL unchanged', () => {
    expect(normalizeUrl('http://example.com/path')).toBe('http://example.com/path');
  });

  it('leaves non-http schemes alone (downstream isHttpUrl filters them)', () => {
    // We don't want normalizeUrl to "fix" file:// / javascript: / data:
    // into https — those should fail validation downstream, not get
    // silently upgraded into something that looks like an HTTP fetch.
    expect(normalizeUrl('file:///etc/passwd')).toBe('file:///etc/passwd');
    expect(normalizeUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(normalizeUrl('data:text/html,hi')).toBe('data:text/html,hi');
  });

  it('prepends https:// to a bare youtube.com URL', () => {
    expect(normalizeUrl('youtube.com/watch?v=jNQXAC9IVRw')).toBe(
      'https://youtube.com/watch?v=jNQXAC9IVRw',
    );
  });

  it('prepends https:// to a bare youtu.be short link', () => {
    expect(normalizeUrl('youtu.be/jNQXAC9IVRw')).toBe('https://youtu.be/jNQXAC9IVRw');
  });

  it('prepends https:// to a www-prefixed bare URL', () => {
    expect(normalizeUrl('www.youtube.com/watch?v=jNQXAC9IVRw')).toBe(
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    );
  });

  it('prepends https:// to a bare URL with a query string', () => {
    expect(normalizeUrl('vimeo.com/12345?foo=bar')).toBe('https://vimeo.com/12345?foo=bar');
  });

  it('prepends https:// to a host-only bare URL', () => {
    expect(normalizeUrl('youtube.com')).toBe('https://youtube.com');
  });

  it('leaves single-word junk alone (no dot in hostname → not a domain)', () => {
    // `not a url` after prepending `https://` parses with hostname
    // `not`, which has no dot. We don't want to fire yt-dlp on it.
    expect(normalizeUrl('not a url')).toBe('not a url');
    expect(normalizeUrl('hello')).toBe('hello');
    expect(normalizeUrl('localhost')).toBe('localhost');
  });

  it('leaves localhost:port alone (no dot in hostname)', () => {
    // Pluck is for public-internet video URLs; localhost is never a
    // real download target.
    expect(normalizeUrl('localhost:3000/x')).toBe('localhost:3000/x');
  });

  it('trims leading and trailing whitespace before processing', () => {
    expect(normalizeUrl('  https://youtube.com/x  ')).toBe('https://youtube.com/x');
    expect(normalizeUrl('  youtube.com/x  ')).toBe('https://youtube.com/x');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeUrl('')).toBe('');
    expect(normalizeUrl('   ')).toBe('');
  });

  it('handles a URL with a port and path', () => {
    expect(normalizeUrl('example.com:8080/foo')).toBe('https://example.com:8080/foo');
  });

  it('is idempotent — running it twice gives the same result', () => {
    const inputs = ['youtube.com/watch?v=X', 'https://youtube.com/watch?v=X', 'not a url', ''];
    for (const input of inputs) {
      expect(normalizeUrl(normalizeUrl(input))).toBe(normalizeUrl(input));
    }
  });
});
