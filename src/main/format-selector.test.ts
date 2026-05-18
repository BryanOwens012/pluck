import { describe, expect, it } from 'vitest';
import { STATIC_FORMAT_CHOICES_ORDERED } from '../shared/types';
import { resolveFormatChoices } from './format-selector';
import type { FormatInfo } from './ytdlp/types';

// Fixture-style format builders. Real yt-dlp `-J` arrays have ~30
// fields per entry; we project to the subset format-selector reads.

const mp4 = (height: number, fps = 30, tbr = 1000): FormatInfo => ({
  ext: 'mp4',
  vcodec: 'avc1.640028',
  acodec: 'mp4a.40.2',
  width: (height * 16) / 9,
  height,
  fps,
  tbr,
});

const webm = (height: number, fps = 30, tbr = 1500): FormatInfo => ({
  ext: 'webm',
  vcodec: 'vp9',
  acodec: 'opus',
  width: (height * 16) / 9,
  height,
  fps,
  tbr,
});

const audioOnly = (): FormatInfo => ({
  ext: 'm4a',
  vcodec: 'none',
  acodec: 'mp4a.40.2',
});

describe('resolveFormatChoices', () => {
  it('returns the static four defaults when formats array is empty', () => {
    expect(resolveFormatChoices([])).toEqual(STATIC_FORMAT_CHOICES_ORDERED);
  });

  it('returns the static four defaults when all formats are audio-only (no video extractor)', () => {
    expect(resolveFormatChoices([audioOnly(), audioOnly()])).toEqual(STATIC_FORMAT_CHOICES_ORDERED);
  });

  it('enriches mp4 labels with real dimensions for a typical YouTube URL (mp4 up to 1080p60)', () => {
    const choices = resolveFormatChoices([
      mp4(1080, 60),
      mp4(1080, 30),
      mp4(720, 60),
      mp4(720, 30),
      mp4(360, 30),
      audioOnly(),
    ]);

    expect(choices).toHaveLength(4); // No 5th — no non-mp4 alternative.

    const best = choices[0];
    expect(best?.id).toBe('best');
    expect(best?.label).toMatch(/Best Quality \(1920×1080 mp4, 60fps\)/);

    const p1080 = choices[1];
    expect(p1080?.id).toBe('1080p');
    expect(p1080?.label).toMatch(/1080p \(1920×1080 mp4, 60fps\)/);

    const p720 = choices[2];
    expect(p720?.id).toBe('720p');
    expect(p720?.label).toMatch(/720p \(1280×720 mp4, 60fps\)/);

    const audio = choices[3];
    expect(audio?.id).toBe('audio_mp3');
    // audio_mp3 label is the static label; no per-URL enrichment.
    expect(audio?.label).toBe('Audio Only (MP3)');
  });

  it('omits the fps suffix when fps is <= 30 (standard 24/25/30 footage)', () => {
    const choices = resolveFormatChoices([mp4(1080, 30), mp4(720, 24)]);
    expect(choices[0]?.label).toMatch(/1920×1080 mp4\)/);
    expect(choices[0]?.label).not.toMatch(/fps/);
  });

  it('adds a 5th option when the best non-mp4 beats the best mp4 on resolution (4K webm vs 1080p mp4)', () => {
    const choices = resolveFormatChoices([
      mp4(1080, 60),
      mp4(720, 60),
      webm(2160, 60),
      webm(1440, 60),
      audioOnly(),
    ]);

    expect(choices).toHaveLength(5);
    const alt = choices[4];
    expect(alt?.id).toBe('best_alt');
    expect(alt?.label).toMatch(/Best \(3840×2160 webm, 60fps\)/);
    // The args target the winning container by ext.
    expect(alt?.ytDlpFormatArgs).toContain('bv*[ext=webm]+ba/b[ext=webm]');
  });

  it('adds a 5th option when same-resolution webm has higher fps (1080p60 webm vs 1080p30 mp4)', () => {
    const choices = resolveFormatChoices([mp4(1080, 30, 2000), webm(1080, 60, 3000)]);
    expect(choices).toHaveLength(5);
    expect(choices[4]?.id).toBe('best_alt');
    expect(choices[4]?.label).toMatch(/1920×1080 webm, 60fps/);
  });

  it('adds a 5th option when same-res same-fps webm has higher tbr (bitrate tiebreaker)', () => {
    const choices = resolveFormatChoices([
      mp4(1080, 60, 5000), //
      webm(1080, 60, 8000),
    ]);
    expect(choices).toHaveLength(5);
    expect(choices[4]?.id).toBe('best_alt');
  });

  it('does NOT add a 5th option when mp4 and webm match exactly (no benefit)', () => {
    const choices = resolveFormatChoices([
      mp4(1080, 60, 5000), //
      webm(1080, 60, 5000),
    ]);
    expect(choices).toHaveLength(4);
  });

  it('does NOT add a 5th option when mp4 strictly beats webm', () => {
    const choices = resolveFormatChoices([mp4(2160, 60), webm(1080, 60)]);
    expect(choices).toHaveLength(4);
  });

  it('falls back to the static label when no mp4 exists at the tier (Vimeo-style webm-only)', () => {
    // No mp4 → enrich returns the static "Best Quality" label without
    // dimensions. The 5th option still appears for the webm.
    const choices = resolveFormatChoices([webm(1080, 30), webm(720, 30)]);
    expect(choices[0]?.label).toBe('Best Quality');
    expect(choices[1]?.label).toBe('1080p');
    expect(choices.find((c) => c.id === 'best_alt')).toBeDefined();
  });

  it('always includes audio_mp3 with its static label (no per-URL enrichment)', () => {
    // Regardless of available video formats, audio_mp3 stays plain
    // because its output is always re-encoded mp3 — describing the
    // SOURCE container would mislead.
    for (const fixture of [[], [mp4(720, 30)], [mp4(2160, 60), webm(2160, 60)]]) {
      const choices = resolveFormatChoices(fixture);
      const audio = choices.find((c) => c.id === 'audio_mp3');
      expect(audio?.label).toBe('Audio Only (MP3)');
    }
  });

  it('handles formats missing fps/tbr fields without throwing', () => {
    // Older yt-dlp versions or weird extractors sometimes omit these.
    const choices = resolveFormatChoices([
      { ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 720 },
      { ext: 'webm', vcodec: 'vp9', acodec: 'opus', height: 1080 },
    ]);
    expect(choices).toHaveLength(5); // webm at 1080 beats mp4 at 720
    const alt = choices[4];
    // No fps suffix when undefined.
    expect(alt?.label).not.toMatch(/fps/);
  });

  it('handles formats with only height (no width) — uses Np shorthand', () => {
    const choices = resolveFormatChoices([
      { ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30 },
    ]);
    expect(choices[0]?.label).toMatch(/1080p mp4/);
  });

  it('returns choices in stable order: best, 1080p, 720p, audio_mp3, [best_alt]', () => {
    const choices = resolveFormatChoices([mp4(1080, 30), webm(2160, 60)]);
    expect(choices.map((c) => c.id)).toEqual(['best', '1080p', '720p', 'audio_mp3', 'best_alt']);
  });
});
