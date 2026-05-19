import { describe, expect, it } from 'vitest';
import { looksLikePlaylistUrl } from './looks-like-playlist';

describe('looksLikePlaylistUrl', () => {
  it('matches a video URL carrying a playlist (watch?v=X&list=Y)', () => {
    expect(
      looksLikePlaylistUrl(
        'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLZbbT5o_s2xr17PqeytCKiCD-TJj89rII&index=2',
      ),
    ).toBe(true);
  });

  it('matches an explicit playlist URL (playlist?list=Y)', () => {
    expect(
      looksLikePlaylistUrl('https://www.youtube.com/playlist?list=PLZbbT5o_s2xr17PqeytCKiCD'),
    ).toBe(true);
  });

  it('matches a channel-style playlist path', () => {
    expect(looksLikePlaylistUrl('https://www.youtube.com/@somechannel/playlist')).toBe(true);
  });

  it('does not match a plain video URL', () => {
    expect(looksLikePlaylistUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBe(false);
    expect(looksLikePlaylistUrl('https://youtu.be/jNQXAC9IVRw')).toBe(false);
  });

  it('returns false for non-URL strings (does not throw)', () => {
    expect(looksLikePlaylistUrl('')).toBe(false);
    expect(looksLikePlaylistUrl('not a url')).toBe(false);
    expect(looksLikePlaylistUrl('//example.com')).toBe(false);
  });
});
