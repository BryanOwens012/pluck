import { describe, expect, it } from 'vitest';
import { isHttpUrl } from './is-http';

describe('isHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBe(true);
    expect(isHttpUrl('https://vimeo.com/12345')).toBe(true);
  });

  it('is case-insensitive on the scheme', () => {
    expect(isHttpUrl('HTTP://example.com')).toBe(true);
    expect(isHttpUrl('HTTPS://example.com')).toBe(true);
    expect(isHttpUrl('hTtPs://example.com')).toBe(true);
  });

  it('rejects other schemes', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>')).toBe(false);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('about:blank')).toBe(false);
  });

  it('rejects bare strings without a scheme', () => {
    expect(isHttpUrl('youtube.com/watch?v=abc')).toBe(false);
    expect(isHttpUrl('//example.com')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });

  it('rejects non-string inputs (defensive against IPC payloads)', () => {
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(42)).toBe(false);
    expect(isHttpUrl({})).toBe(false);
    expect(isHttpUrl(['https://example.com'])).toBe(false);
  });
});
