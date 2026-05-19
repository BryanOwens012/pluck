import { describe, expect, it } from 'vitest';
import { STATIC_FORMAT_CHOICES } from '../../shared/types';
import {
  buildDownloadArgs,
  buildMetadataArgs,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  FINAL_PATH_MARKER_FILENAME,
} from './args';
import type { RunDownloadOptions, RunnerDeps } from './types';

const DEPS: RunnerDeps = { ytDlpPath: '/fake/yt-dlp', ffmpegPath: '/fake/ffmpeg' };

/** Build a RunDownloadOptions for one of the static presets — sugar
 * to avoid every test repeating the ytDlpFormatArgs lookup. */
const optsForPreset = (
  preset: keyof typeof STATIC_FORMAT_CHOICES,
  overrides: Partial<RunDownloadOptions> = {},
): RunDownloadOptions => ({
  url: 'https://example.com/x',
  tempFolder: '/tmp/work',
  ytDlpFormatArgs: STATIC_FORMAT_CHOICES[preset].ytDlpFormatArgs,
  ...overrides,
});

// ---- STATIC_FORMAT_CHOICES ---------------------------------------------
//
// The four static FormatChoice entries are now the source of truth for
// preset args. Smoke-test their shape here — argv-recorder tests in
// runner.test.ts cover the integration via real spawn.

describe('STATIC_FORMAT_CHOICES', () => {
  it('best: mp4 filter + av1 exclusion + m4a audio + single-file mp4 fallback + -S sort', () => {
    expect(STATIC_FORMAT_CHOICES.best.ytDlpFormatArgs).toEqual([
      '-f',
      'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]',
      '-S',
      'res,vcodec:h264,fps',
    ]);
  });

  it('1080p: same shape with height cap', () => {
    expect(STATIC_FORMAT_CHOICES['1080p'].ytDlpFormatArgs).toEqual([
      '-f',
      'bv*[ext=mp4][vcodec!*=av01][height<=1080]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=1080]',
      '-S',
      'res,vcodec:h264,fps',
    ]);
  });

  it('720p: same shape with height cap', () => {
    expect(STATIC_FORMAT_CHOICES['720p'].ytDlpFormatArgs).toEqual([
      '-f',
      'bv*[ext=mp4][vcodec!*=av01][height<=720]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=720]',
      '-S',
      'res,vcodec:h264,fps',
    ]);
  });

  it('audio_mp3: extraction path with mp3 + best quality, no -S sort', () => {
    // -S would be wasted here — mp3 re-encodes regardless of source
    // container, so sorting by res/fps/vcodec doesn't affect the output.
    expect(STATIC_FORMAT_CHOICES.audio_mp3.ytDlpFormatArgs).toEqual([
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
    ]);
    expect(STATIC_FORMAT_CHOICES.audio_mp3.ytDlpFormatArgs).not.toContain('-S');
  });

  it('regression: bare bv*+ba/b (pre-PR-9.6) is never used in static presets', () => {
    // The pre-PR string would let yt-dlp serve YouTube's vp9/webm as the
    // default. If a future refactor accidentally drops [ext=mp4], this
    // test catches it — the .webm output silently breaks QuickTime / iMessage.
    for (const id of ['best', '1080p', '720p'] as const) {
      const flag = STATIC_FORMAT_CHOICES[id].ytDlpFormatArgs.join(' ');
      expect(flag).toContain('[ext=mp4]');
    }
  });
});

// ---- buildMetadataArgs --------------------------------------------------

describe('buildMetadataArgs', () => {
  it('returns -J --no-download <url> when no options are set', () => {
    expect(buildMetadataArgs('https://example.com/x', {})).toEqual([
      '-J',
      '--no-download',
      'https://example.com/x',
    ]);
  });

  it('inserts --cookies-from-browser before the URL when configured', () => {
    expect(buildMetadataArgs('https://example.com/x', { cookiesFromBrowser: 'chrome' })).toEqual([
      '-J',
      '--no-download',
      '--cookies-from-browser',
      'chrome',
      'https://example.com/x',
    ]);
  });

  it('treats empty-string cookiesFromBrowser as unset (skips the flag)', () => {
    // Defensive: an empty string would otherwise become a no-op CLI arg
    // and trip yt-dlp's flag parser.
    const args = buildMetadataArgs('https://example.com/x', { cookiesFromBrowser: '' });
    expect(args).not.toContain('--cookies-from-browser');
    expect(args.at(-1)).toBe('https://example.com/x');
  });
});

// ---- buildDownloadArgs --------------------------------------------------

describe('buildDownloadArgs', () => {
  it('produces a markerPath under the tempFolder', () => {
    const { markerPath } = buildDownloadArgs(optsForPreset('best'), DEPS);
    expect(markerPath).toBe(`/tmp/work/${FINAL_PATH_MARKER_FILENAME}`);
  });

  it('falls back to DEFAULT_DOWNLOAD_CONCURRENCY when concurrentFragments unset', () => {
    const { args } = buildDownloadArgs(optsForPreset('best'), DEPS);
    const nIdx = args.indexOf('-N');
    expect(args[nIdx + 1]).toBe(String(DEFAULT_DOWNLOAD_CONCURRENCY));
  });

  it('passes the supplied concurrentFragments value to -N', () => {
    const { args } = buildDownloadArgs(optsForPreset('best', { concurrentFragments: 4 }), DEPS);
    const nIdx = args.indexOf('-N');
    expect(args[nIdx + 1]).toBe('4');
  });

  it('appends --video-password when set', () => {
    const { args } = buildDownloadArgs(optsForPreset('best', { videoPassword: 'sekret' }), DEPS);
    expect(args).toContain('--video-password');
    expect(args[args.indexOf('--video-password') + 1]).toBe('sekret');
  });

  it('omits --video-password when unset (no empty-string pollution)', () => {
    const { args } = buildDownloadArgs(optsForPreset('best'), DEPS);
    expect(args).not.toContain('--video-password');
  });

  it('appends --cookies-from-browser when set', () => {
    const { args } = buildDownloadArgs(
      optsForPreset('best', { cookiesFromBrowser: 'firefox' }),
      DEPS,
    );
    expect(args).toContain('--cookies-from-browser');
    expect(args[args.indexOf('--cookies-from-browser') + 1]).toBe('firefox');
  });

  it('places URL last (yt-dlp positional arg convention)', () => {
    const { args } = buildDownloadArgs(
      optsForPreset('best', { cookiesFromBrowser: 'chrome', videoPassword: 'pw' }),
      DEPS,
    );
    expect(args.at(-1)).toBe('https://example.com/x');
  });

  it('threads --ffmpeg-location from deps so yt-dlp finds the bundled binary', () => {
    const { args } = buildDownloadArgs(optsForPreset('best'), DEPS);
    expect(args).toContain('--ffmpeg-location');
    expect(args[args.indexOf('--ffmpeg-location') + 1]).toBe('/fake/ffmpeg');
  });

  it('uses --paths home:<tempFolder> so yt-dlp writes fragments + merged output there', () => {
    const { args } = buildDownloadArgs(optsForPreset('best'), DEPS);
    expect(args).toContain('--paths');
    expect(args[args.indexOf('--paths') + 1]).toBe('home:/tmp/work');
  });

  it('includes the format flags inline', () => {
    // Defense against accidental drop of the spread.
    const { args } = buildDownloadArgs(optsForPreset('720p'), DEPS);
    expect(args).toContain('-f');
    expect(args).toContain(
      'bv*[ext=mp4][vcodec!*=av01][height<=720]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=720]',
    );
  });
});
