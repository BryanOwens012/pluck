import { describe, expect, it } from 'vitest';
import { STATIC_FORMAT_CHOICES_ORDERED } from '../../../shared/types';
import type { FormatInfo } from '../../ytdlp/types';
import { resolveFormatChoices } from './format-selector';

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

  it('drops the duplicate 1080p tier when best mp4 is 1080p, keeps the lower tiers the URL actually has', () => {
    // Best is exactly 1080p. The fixture also has mp4 at 720p and 360p
    // (but NOT 480p). The dropdown should be:
    //   Best (1080p) ← shorthand-annotated best, dedupe of the 1080p tier
    //   720p          ← present in source
    //   360p          ← present in source
    //   Audio only (mp3)
    // 480p is dropped because the source has no ≥480p mp4 besides the
    // ones that already get covered by other rows.
    const choices = resolveFormatChoices([
      mp4(1080, 60),
      mp4(1080, 30),
      mp4(720, 60),
      mp4(720, 30),
      mp4(360, 30),
      audioOnly(),
    ]);

    expect(choices.map((c) => c.id)).toEqual(['best', '720p', '360p', 'audio_mp3']);

    const best = choices[0];
    expect(best?.id).toBe('best');
    expect(best?.label).toBe('Best');
    expect(best?.shorthand).toBe('1080p');
    expect(best?.detail).toBe('1920×1080 mp4, 60fps');

    const p720 = choices[1];
    expect(p720?.id).toBe('720p');
    expect(p720?.label).toBe('720p');
    expect(p720?.shorthand).toBeUndefined();
    expect(p720?.detail).toBe('1280×720 mp4, 60fps');

    const audio = choices[3];
    expect(audio?.id).toBe('audio_mp3');
    expect(audio?.label).toBe('Audio only (mp3)');
    expect(audio?.shorthand).toBeUndefined();
    expect(audio?.detail).toBeUndefined();
  });

  it('keeps every available lower tier when best mp4 exceeds all of them (4K best)', () => {
    // Best is 4K. All four lower tiers offer real value and stay.
    const choices = resolveFormatChoices([
      mp4(2160, 60),
      mp4(1080, 60),
      mp4(720, 60),
      mp4(480, 60),
      mp4(360, 60),
    ]);
    expect(choices.map((c) => c.id)).toEqual([
      'best',
      '1080p',
      '720p',
      '480p',
      '360p',
      'audio_mp3',
    ]);
    expect(choices[0]?.shorthand).toBe('4K');
  });

  it('drops the 1080p tier when best mp4 only goes to 720p, keeps lower tiers that exist', () => {
    // Showing "1080p" when no 1080p is available would silently fall
    // back to 720p and confuse the user. 720p is the best, so it gets
    // deduped too. 480p exists in the fixture so it stays.
    const choices = resolveFormatChoices([mp4(720, 30), mp4(480, 30)]);
    expect(choices.map((c) => c.id)).toEqual(['best', '480p', 'audio_mp3']);
    expect(choices[0]?.shorthand).toBe('720p');
  });

  it('maps probed height to the right consumer shorthand on the `best` choice', () => {
    const cases: Array<{ height: number; shorthand: string }> = [
      { height: 4320, shorthand: '8K' },
      { height: 3456, shorthand: '6K' },
      { height: 2880, shorthand: '5K' },
      { height: 2160, shorthand: '4K' },
      { height: 1440, shorthand: '2K' },
      { height: 1080, shorthand: '1080p' },
      { height: 720, shorthand: '720p' },
      { height: 480, shorthand: '480p' },
      { height: 360, shorthand: '360p' },
      { height: 240, shorthand: '240p' },
      { height: 144, shorthand: '240p' }, // floor — never go below 240p
    ];
    for (const { height, shorthand } of cases) {
      const choices = resolveFormatChoices([mp4(height, 30)]);
      expect(choices[0]?.shorthand).toBe(shorthand);
    }
  });

  it('omits the fps suffix when fps is <= 30 (standard 24/25/30 footage)', () => {
    const choices = resolveFormatChoices([mp4(1080, 30), mp4(720, 24)]);
    expect(choices[0]?.detail).toBe('1920×1080 mp4');
    expect(choices[0]?.detail).not.toMatch(/fps/);
  });

  it('adds a best_alt option labelled by shorthand + ext when non-mp4 beats best mp4 (4K webm vs 1080p mp4)', () => {
    const choices = resolveFormatChoices([
      mp4(1080, 60),
      mp4(720, 60),
      webm(2160, 60),
      webm(1440, 60),
      audioOnly(),
    ]);

    const alt = choices.find((c) => c.id === 'best_alt');
    expect(alt).toBeDefined();
    expect(alt?.label).toBe('4K');
    expect(alt?.detail).toBe('webm');
    // The args target the winning container by ext.
    expect(alt?.ytDlpFormatArgs).toContain('bv*[ext=webm]+ba/b[ext=webm]');
    // best_alt still gets the audio embed flags so the webm/mkv file
    // shows cover art + metadata the same way mp4 presets do. Subtitle
    // flags are NOT in the preset — they're added by buildDownloadArgs
    // only when the user has cookies set.
    expect(alt?.ytDlpFormatArgs).toContain('--embed-thumbnail');
    expect(alt?.ytDlpFormatArgs).toContain('--add-metadata');
    expect(alt?.ytDlpFormatArgs).not.toContain('--embed-subs');
    // best_alt always lands at the bottom.
    expect(choices.at(-1)?.id).toBe('best_alt');
  });

  it('adds a best_alt option when same-resolution webm has higher fps (1080p60 webm vs 1080p30 mp4)', () => {
    const choices = resolveFormatChoices([mp4(1080, 30, 2000), webm(1080, 60, 3000)]);
    const alt = choices.find((c) => c.id === 'best_alt');
    expect(alt).toBeDefined();
    expect(alt?.label).toBe('1080p');
    expect(alt?.detail).toBe('webm');
  });

  it('adds a best_alt option when same-res same-fps webm has higher tbr (bitrate tiebreaker)', () => {
    const choices = resolveFormatChoices([
      mp4(1080, 60, 5000), //
      webm(1080, 60, 8000),
    ]);
    expect(choices.find((c) => c.id === 'best_alt')).toBeDefined();
  });

  it('does NOT add a best_alt option when mp4 and webm match exactly (no benefit)', () => {
    const choices = resolveFormatChoices([
      mp4(1080, 60, 5000), //
      webm(1080, 60, 5000),
    ]);
    expect(choices.find((c) => c.id === 'best_alt')).toBeUndefined();
  });

  it('does NOT add a best_alt option when mp4 strictly beats webm', () => {
    const choices = resolveFormatChoices([mp4(2160, 60), webm(1080, 60)]);
    expect(choices.find((c) => c.id === 'best_alt')).toBeUndefined();
  });

  it('leaves detail undefined when no mp4 exists at the tier (Vimeo-style webm-only)', () => {
    // No mp4 → enrich returns the static base unchanged (no `detail`
    // attached). The best_alt option still appears for the webm.
    const choices = resolveFormatChoices([webm(1080, 30), webm(720, 30)]);
    expect(choices[0]?.label).toBe('Best');
    expect(choices[0]?.detail).toBeUndefined();
    expect(choices.find((c) => c.id === 'best_alt')).toBeDefined();
  });

  it('always includes audio_mp3 with its static label (no per-URL enrichment)', () => {
    // Regardless of available video formats, audio_mp3 stays plain
    // because its output is always re-encoded mp3 — describing the
    // SOURCE container would mislead.
    for (const fixture of [[], [mp4(720, 30)], [mp4(2160, 60), webm(2160, 60)]]) {
      const choices = resolveFormatChoices(fixture);
      const audio = choices.find((c) => c.id === 'audio_mp3');
      expect(audio?.label).toBe('Audio only (mp3)');
    }
  });

  it('handles formats missing fps/tbr fields without throwing', () => {
    // Older yt-dlp versions or weird extractors sometimes omit these.
    const choices = resolveFormatChoices([
      { ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 720 },
      { ext: 'webm', vcodec: 'vp9', acodec: 'opus', height: 1080 },
    ]);
    const alt = choices.find((c) => c.id === 'best_alt');
    expect(alt).toBeDefined();
    expect(alt?.label).toBe('1080p');
    expect(alt?.detail).toBe('webm');
  });

  it('handles formats with only height (no width) — uses Np shorthand in detail', () => {
    const choices = resolveFormatChoices([
      { ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 1080, fps: 30 },
    ]);
    expect(choices[0]?.detail).toBe('1080p mp4');
  });

  it('places best_alt at the bottom of the dropdown', () => {
    const choices = resolveFormatChoices([mp4(1080, 30), webm(2160, 60)]);
    expect(choices.at(-1)?.id).toBe('best_alt');
  });

  it('excludes AV1-in-mp4 from the best-mp4 pick (M1/M2 Macs have no AV1 hw decode)', () => {
    // Source serves 1080p60 in av01-mp4 AND 1080p30 in h264-mp4. The
    // av01 entry would otherwise win the (height, fps) tiebreaker; we
    // skip it so the labels match what `[vcodec!*=av01]` actually
    // downloads.
    const av01_1080p60: FormatInfo = {
      ext: 'mp4',
      vcodec: 'av01.0.08M.08',
      acodec: 'mp4a.40.2',
      width: 1920,
      height: 1080,
      fps: 60,
      tbr: 3000,
    };
    const choices = resolveFormatChoices([av01_1080p60, mp4(1080, 30, 2000)]);
    const best = choices[0];
    expect(best?.id).toBe('best');
    // Detail should describe the h264 30fps stream, not the av01 60fps.
    expect(best?.detail).toBe('1920×1080 mp4');
    expect(best?.detail).not.toMatch(/fps/);
  });

  it('falls back to static defaults when the only video is AV1-in-mp4', () => {
    const av01: FormatInfo = {
      ext: 'mp4',
      vcodec: 'av01.0.08M.08',
      acodec: 'mp4a.40.2',
      width: 1920,
      height: 1080,
      fps: 60,
    };
    expect(resolveFormatChoices([av01])).toEqual(STATIC_FORMAT_CHOICES_ORDERED);
  });

  it('drops the 1080p tier when no mp4 reaches 1080p even though best is higher (mp4 mix)', () => {
    // Hypothetical: best mp4 is at 4K but no 1080p mp4 stream exists —
    // the only mp4 below 4K is at 720p. Showing "1080p" in the dropdown
    // would silently pick the 720p file. Better to omit the tier.
    const choices = resolveFormatChoices([mp4(2160, 60), mp4(720, 60)]);
    expect(choices.map((c) => c.id)).toEqual(['best', '720p', 'audio_mp3']);
    expect(choices[0]?.shorthand).toBe('4K');
  });
});
