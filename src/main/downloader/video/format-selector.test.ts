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

const m4aAudio = (): FormatInfo => ({
  ext: 'm4a',
  vcodec: 'none',
  acodec: 'mp4a.40.2',
});

const opusAudio = (): FormatInfo => ({
  ext: 'webm',
  vcodec: 'none',
  acodec: 'opus',
});

const av01Mp4 = (height: number, fps = 30, tbr = 3000): FormatInfo => ({
  ext: 'mp4',
  vcodec: 'av01.0.08M.08',
  acodec: 'mp4a.40.2',
  width: (height * 16) / 9,
  height,
  fps,
  tbr,
});

describe('resolveFormatChoices', () => {
  it('returns the static defaults when formats array is empty', () => {
    expect(resolveFormatChoices([])).toEqual(STATIC_FORMAT_CHOICES_ORDERED);
  });

  it('returns the static defaults when all formats are audio-only', () => {
    expect(resolveFormatChoices([m4aAudio(), opusAudio()])).toEqual(STATIC_FORMAT_CHOICES_ORDERED);
  });

  it("returns the static defaults when the only video is AV1 (AV1-only sources can't be downloaded)", () => {
    expect(resolveFormatChoices([av01Mp4(1080, 60), m4aAudio()])).toEqual(
      STATIC_FORMAT_CHOICES_ORDERED,
    );
  });

  it('1080p source: Best detail is "1080p mp4", 1080p tier is deduped', () => {
    // Source has 1080p mp4 + m4a audio. Best resolves to 1080p mp4.
    // Dropdown should be: Best (1080p mp4), 720p mp4, 360p mp4, Audio-only mp3.
    // 480p is absent from source so dropped.
    const choices = resolveFormatChoices([mp4(1080, 60), mp4(720, 60), mp4(360, 30), m4aAudio()]);

    expect(choices.map((c) => c.id)).toEqual(['best', '720p', '360p', 'audio_mp3']);

    const best = choices[0];
    expect(best?.label).toBe('Best');
    expect(best?.detail).toBe('1080p mp4');
    expect(best?.shorthand).toBe('1080p');

    // Lower tiers carry their resolution + container in the label.
    expect(choices[1]?.label).toBe('720p mp4');
    expect(choices[2]?.label).toBe('360p mp4');
    expect(choices[3]?.label).toBe('Audio-only mp3');
  });

  it('4K WebM source: Best detail is "4K mkv" (mixed container merges to mkv)', () => {
    // YouTube 4K is VP9 webm. Audio is m4a. Mixed container merge → mkv.
    const choices = resolveFormatChoices([webm(2160, 60), mp4(1080, 60), mp4(720, 60), m4aAudio()]);

    expect(choices.map((c) => c.id)).toEqual(['best', '1080p', '720p', 'audio_mp3']);

    const best = choices[0];
    expect(best?.detail).toBe('4K mkv');
    expect(best?.shorthand).toBe('4K');

    // Lower mp4 tiers still appear because the source has them.
    expect(choices[1]?.label).toBe('1080p mp4');
  });

  it('4K WebM + opus only (no m4a): Best detail is "4K mkv"', () => {
    // Without m4a audio, predicted output container is mkv regardless.
    const choices = resolveFormatChoices([webm(2160, 60), opusAudio()]);
    expect(choices[0]?.detail).toBe('4K mkv');
  });

  it('keeps every lower tier when Best is higher than 1080p', () => {
    const choices = resolveFormatChoices([
      webm(2160, 60),
      mp4(1080, 60),
      mp4(720, 60),
      mp4(480, 60),
      mp4(360, 60),
      m4aAudio(),
    ]);
    expect(choices.map((c) => c.id)).toEqual([
      'best',
      '1080p',
      '720p',
      '480p',
      '360p',
      'audio_mp3',
    ]);
  });

  it('drops the 1080p tier when no non-AV1 mp4 reaches 1080p', () => {
    // Source has 4K webm + 720p mp4 only. "1080p mp4" would silently
    // resolve to 720p mp4, so we omit it from the dropdown.
    const choices = resolveFormatChoices([webm(2160, 60), mp4(720, 60), m4aAudio()]);
    expect(choices.map((c) => c.id)).toEqual(['best', '720p', 'audio_mp3']);
  });

  it('720p mp4 source: Best resolves to 720p mp4, the 720p tier is deduped', () => {
    const choices = resolveFormatChoices([mp4(720, 30), mp4(480, 30), m4aAudio()]);
    expect(choices.map((c) => c.id)).toEqual(['best', '480p', 'audio_mp3']);
    expect(choices[0]?.detail).toBe('720p mp4');
  });

  it('maps probed height to the right consumer shorthand', () => {
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
      const choices = resolveFormatChoices([mp4(height, 30), m4aAudio()]);
      expect(choices[0]?.shorthand).toBe(shorthand);
    }
  });

  it('AV1 streams are ignored when a non-AV1 alternative exists at the same height', () => {
    // 1080p has both AV1 mp4 and h264 mp4. Best should be the h264 stream,
    // not the AV1 one. Detail should be "1080p mp4" (predicted output).
    const choices = resolveFormatChoices([av01Mp4(1080, 60), mp4(1080, 30), m4aAudio()]);
    const best = choices[0];
    expect(best?.shorthand).toBe('1080p');
    expect(best?.detail).toBe('1080p mp4');
  });

  it('AV1 is the only option at 8K but VP9 is best at 4K: Best caps at 4K (matches QUALITY_FIRST_BEST_CHOICE behaviour)', () => {
    // YouTube's actual structure: 8K AV1-only, 4K both VP9 and AV1, lower h264.
    const choices = resolveFormatChoices([
      av01Mp4(4320, 60), // 8K — excluded by AV1 filter
      webm(2160, 60), // 4K VP9 — Best lands here
      av01Mp4(2160, 60), // 4K AV1 — excluded
      mp4(1080, 60), // 1080p h264
      m4aAudio(),
    ]);
    expect(choices[0]?.shorthand).toBe('4K');
    expect(choices[0]?.detail).toBe('4K mkv'); // 4K VP9 webm + m4a → mkv
  });

  it('always includes audio_mp3 with the static "Audio-only mp3" label', () => {
    for (const fixture of [[], [mp4(720, 30), m4aAudio()], [webm(2160, 60), m4aAudio()]]) {
      const choices = resolveFormatChoices(fixture);
      const audio = choices.find((c) => c.id === 'audio_mp3');
      expect(audio?.label).toBe('Audio-only mp3');
    }
  });

  it('handles formats missing fps/tbr fields without throwing', () => {
    const choices = resolveFormatChoices([
      { ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 720 },
      { ext: 'webm', vcodec: 'vp9', acodec: 'opus', height: 1080 },
    ]);
    expect(choices[0]?.shorthand).toBe('1080p');
    expect(choices[0]?.detail).toBe('1080p mkv'); // webm video + (no m4a) → mkv
  });
});
