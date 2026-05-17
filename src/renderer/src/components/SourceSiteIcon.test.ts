import { describe, expect, it } from 'vitest';
import { resolveSiteGlyph } from './SourceSiteIcon';

describe('resolveSiteGlyph', () => {
  it('returns the YouTube glyph for the youtube extractor', () => {
    const glyph = resolveSiteGlyph('youtube');
    expect(glyph.letter).toBe('Y');
    expect(glyph.label).toBe('YouTube');
  });

  it('returns the Vimeo glyph for the vimeo extractor', () => {
    expect(resolveSiteGlyph('vimeo').label).toBe('Vimeo');
  });

  it('returns the Zoom glyph for the zoom extractor', () => {
    expect(resolveSiteGlyph('zoom').label).toBe('Zoom');
  });

  it('strips yt-dlp colon-suffixes (youtube:tab, youtube:playlist, etc.)', () => {
    expect(resolveSiteGlyph('youtube:tab').label).toBe('YouTube');
    expect(resolveSiteGlyph('youtube:playlist').label).toBe('YouTube');
    expect(resolveSiteGlyph('vimeo:channel').label).toBe('Vimeo');
  });

  it('is case-insensitive', () => {
    expect(resolveSiteGlyph('YouTube').label).toBe('YouTube');
    expect(resolveSiteGlyph('YOUTUBE').label).toBe('YouTube');
    expect(resolveSiteGlyph('Zoom').label).toBe('Zoom');
  });

  it('falls back to the generic glyph for unknown extractors', () => {
    expect(resolveSiteGlyph('somerandomsite').label).toBe('External site');
    expect(resolveSiteGlyph('generic').label).toBe('External site');
  });

  it('falls back to the generic glyph for undefined / empty input', () => {
    expect(resolveSiteGlyph(undefined).label).toBe('External site');
    expect(resolveSiteGlyph('').label).toBe('External site');
  });
});
