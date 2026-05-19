import { describe, expect, it } from 'vitest';
import { STATIC_FORMAT_CHOICES } from '../../shared/types';
import {
  buildDownloadArgs,
  buildMetadataArgs,
  DEFAULT_DOWNLOAD_CONCURRENCY,
  extractKnownFlags,
  FINAL_PATH_MARKER_FILENAME,
  formatInvocationForDisplay,
  parseYtDlpCommand,
  URL_PLACEHOLDER_TOKEN,
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
  it('best: mp4 filter + av1 exclusion + m4a audio + single-file mp4 fallback + -S sort + embed flags', () => {
    expect(STATIC_FORMAT_CHOICES.best.ytDlpFormatArgs).toEqual([
      '-f',
      'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]',
      '-S',
      'res,vcodec:h264,fps',
      '--embed-thumbnail',
      '--add-metadata',
      '--embed-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en.*,zh.*,es.*,hi.*,ar.*,bn.*,pt.*,fr.*,de.*,ja.*,ko.*',
    ]);
  });

  it('1080p: same shape with height cap', () => {
    expect(STATIC_FORMAT_CHOICES['1080p'].ytDlpFormatArgs).toEqual([
      '-f',
      'bv*[ext=mp4][vcodec!*=av01][height<=1080]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=1080]',
      '-S',
      'res,vcodec:h264,fps',
      '--embed-thumbnail',
      '--add-metadata',
      '--embed-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en.*,zh.*,es.*,hi.*,ar.*,bn.*,pt.*,fr.*,de.*,ja.*,ko.*',
    ]);
  });

  it('720p: same shape with height cap', () => {
    expect(STATIC_FORMAT_CHOICES['720p'].ytDlpFormatArgs).toEqual([
      '-f',
      'bv*[ext=mp4][vcodec!*=av01][height<=720]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=720]',
      '-S',
      'res,vcodec:h264,fps',
      '--embed-thumbnail',
      '--add-metadata',
      '--embed-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en.*,zh.*,es.*,hi.*,ar.*,bn.*,pt.*,fr.*,de.*,ja.*,ko.*',
    ]);
  });

  it('audio_mp3: extraction path with mp3 + best quality + audio embed flags, no -S sort, no subs', () => {
    // -S would be wasted here — mp3 re-encodes regardless of source
    // container, so sorting by res/fps/vcodec doesn't affect the output.
    // --embed-subs is also pointless (mp3 has no subtitle track concept)
    // so audio_mp3 only carries the audio-shared embed flags.
    expect(STATIC_FORMAT_CHOICES.audio_mp3.ytDlpFormatArgs).toEqual([
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '--embed-thumbnail',
      '--add-metadata',
    ]);
    expect(STATIC_FORMAT_CHOICES.audio_mp3.ytDlpFormatArgs).not.toContain('-S');
    expect(STATIC_FORMAT_CHOICES.audio_mp3.ytDlpFormatArgs).not.toContain('--embed-subs');
  });

  it('every video preset pins [ext=mp4] in its selector', () => {
    // A bare `bv*+ba/b` selector lets yt-dlp serve YouTube's vp9/webm
    // by default, which silently breaks QuickTime / iMessage. This
    // guard catches accidental removal of the container constraint.
    for (const id of ['best', '1080p', '720p', '480p', '360p'] as const) {
      const flag = STATIC_FORMAT_CHOICES[id].ytDlpFormatArgs.join(' ');
      expect(flag).toContain('[ext=mp4]');
    }
  });

  it('every video preset embeds thumbnail + metadata + subs', () => {
    for (const id of ['best', '1080p', '720p', '480p', '360p'] as const) {
      const args = STATIC_FORMAT_CHOICES[id].ytDlpFormatArgs;
      expect(args).toContain('--embed-thumbnail');
      expect(args).toContain('--add-metadata');
      expect(args).toContain('--embed-subs');
      expect(args).toContain('--write-auto-subs');
      expect(args).toContain('--sub-langs');
    }
  });

  it('480p caps height in the selector', () => {
    const flag = STATIC_FORMAT_CHOICES['480p'].ytDlpFormatArgs.join(' ');
    expect(flag).toContain('[height<=480]');
    expect(flag).not.toContain('[height<=1080]');
  });

  it('360p caps height in the selector', () => {
    const flag = STATIC_FORMAT_CHOICES['360p'].ytDlpFormatArgs.join(' ');
    expect(flag).toContain('[height<=360]');
    expect(flag).not.toContain('[height<=720]');
  });
});

// ---- parseYtDlpCommand --------------------------------------------------

describe('parseYtDlpCommand', () => {
  it('tokenizes a plain command with no quotes', () => {
    const result = parseYtDlpCommand('yt-dlp -N 4 https://example.com/x');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual(['-N', '4', 'https://example.com/x']);
    }
  });

  it('preserves single-quoted spans literally', () => {
    const result = parseYtDlpCommand("yt-dlp -f 'bv*[ext=mp4]+ba[ext=m4a]'");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual(['-f', 'bv*[ext=mp4]+ba[ext=m4a]']);
    }
  });

  it('handles double-quoted spans with embedded escapes', () => {
    const result = parseYtDlpCommand('yt-dlp -o "title with \\"quotes\\".mp4"');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual(['-o', 'title with "quotes".mp4']);
    }
  });

  it('joins lines on backslash-newline continuation outside quotes', () => {
    const result = parseYtDlpCommand('yt-dlp \\\n  -N 4 \\\n  -f best');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual(['-N', '4', '-f', 'best']);
    }
  });

  it('joins lines on backslash-newline continuation inside double quotes', () => {
    const result = parseYtDlpCommand('yt-dlp -o "part-a\\\npart-b"');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual(['-o', 'part-apart-b']);
    }
  });

  it('rejects a leading non-yt-dlp token', () => {
    const result = parseYtDlpCommand('curl https://example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/yt-dlp/);
    }
  });

  it('rejects empty input', () => {
    const result = parseYtDlpCommand('   \n\t  ');
    expect(result.ok).toBe(false);
  });

  it('rejects unterminated single-quoted string', () => {
    expect(parseYtDlpCommand("yt-dlp -f 'unterminated").ok).toBe(false);
  });

  it('rejects unterminated double-quoted string', () => {
    expect(parseYtDlpCommand('yt-dlp -f "unterminated').ok).toBe(false);
  });

  it('treats shell metacharacters as inert literal tokens (no expansion)', () => {
    // The whole point of the no-expansion contract: typing
    // `&& rm -rf /` doesn't actually spawn rm — these tokens just
    // become inert args yt-dlp will reject.
    const result = parseYtDlpCommand('yt-dlp -f best && rm -rf /');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.argv).toEqual(['-f', 'best', '&&', 'rm', '-rf', '/']);
    }
  });

  it('keeps $() unparsed in URLs (regression smoke for shell injection)', () => {
    // A URL containing `$(touch /tmp/PWN)` should land as a single
    // literal token, not as a subshell expansion.
    const result = parseYtDlpCommand('yt-dlp https://x.com/$(touch /tmp/PWN)');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Spaces in the URL break it into multiple tokens at the
      // tokenizer level — that's fine; yt-dlp would reject the
      // garbage flags. What matters is no shell expansion happened.
      expect(result.argv.join(' ')).toContain('$(touch');
    }
  });
});

// ---- extractKnownFlags --------------------------------------------------

describe('extractKnownFlags', () => {
  it('extracts -N as a positive integer', () => {
    expect(extractKnownFlags(['-N', '4'])).toEqual({ concurrentFragments: 4 });
  });

  it('ignores -N with a non-numeric value', () => {
    expect(extractKnownFlags(['-N', 'fast'])).toEqual({});
  });

  it('extracts --cookies-from-browser only for known names', () => {
    expect(extractKnownFlags(['--cookies-from-browser', 'firefox'])).toEqual({
      cookiesFromBrowser: 'firefox',
    });
    // Unknown browser → ignored.
    expect(extractKnownFlags(['--cookies-from-browser', 'lynx'])).toEqual({});
  });

  it('extracts -f and -o', () => {
    expect(extractKnownFlags(['-f', 'bestaudio', '-o', '%(title)s.%(ext)s'])).toEqual({
      format: 'bestaudio',
      outputTemplate: '%(title)s.%(ext)s',
    });
  });

  it('handles --format and --output long-form aliases', () => {
    expect(extractKnownFlags(['--format', 'best', '--output', 'x.mp4'])).toEqual({
      format: 'best',
      outputTemplate: 'x.mp4',
    });
  });

  it('combines multiple flags in a single argv', () => {
    expect(
      extractKnownFlags([
        '-N',
        '8',
        '--cookies-from-browser',
        'chrome',
        '-f',
        'best',
        '-o',
        '~/Downloads/x.mp4',
      ]),
    ).toEqual({
      concurrentFragments: 8,
      cookiesFromBrowser: 'chrome',
      format: 'best',
      outputTemplate: '~/Downloads/x.mp4',
    });
  });

  it('ignores flags whose value is missing (last-token flag)', () => {
    expect(extractKnownFlags(['-N'])).toEqual({});
  });
});

// ---- formatInvocationForDisplay ----------------------------------------

describe('formatInvocationForDisplay', () => {
  it('renders a plain argv as space-joined `yt-dlp ...`', () => {
    expect(formatInvocationForDisplay(['-f', 'best', 'https://x.com/y'])).toBe(
      'yt-dlp -f best https://x.com/y',
    );
  });

  it('single-quote-wraps args containing spaces', () => {
    expect(formatInvocationForDisplay(['-o', 'My Video.mp4'])).toBe("yt-dlp -o 'My Video.mp4'");
  });

  it('escapes embedded single quotes via the close/escape/reopen dance', () => {
    expect(formatInvocationForDisplay(['-o', "It's a file"])).toBe("yt-dlp -o 'It'\\''s a file'");
  });

  it("redacts the value after --video-password as '***'", () => {
    expect(formatInvocationForDisplay(['--video-password', 'sekret', 'https://x.com/y'])).toBe(
      "yt-dlp --video-password '***' https://x.com/y",
    );
  });

  it('quotes args containing shell metacharacters', () => {
    expect(formatInvocationForDisplay(['-f', 'bv*[ext=mp4]+ba'])).toBe(
      "yt-dlp -f 'bv*[ext=mp4]+ba'",
    );
  });

  it('renders an empty string arg as empty single-quotes', () => {
    expect(formatInvocationForDisplay(['-o', ''])).toBe("yt-dlp -o ''");
  });
});

// ---- buildDownloadArgs override branch ---------------------------------

describe('buildDownloadArgs override mode', () => {
  it('substitutes <URL> placeholder when the override contains it', () => {
    const { args } = buildDownloadArgs(
      optsForPreset('best', {
        ytDlpCommandOverride: `yt-dlp -f best ${URL_PLACEHOLDER_TOKEN} --some-flag`,
      }),
      DEPS,
    );
    // URL lands where the placeholder was.
    expect(args).toContain('https://example.com/x');
    expect(args.indexOf('https://example.com/x')).toBeLessThan(args.indexOf('--some-flag'));
    expect(args).not.toContain(URL_PLACEHOLDER_TOKEN);
  });

  it('appends URL at the end when the override has no <URL> placeholder', () => {
    const { args } = buildDownloadArgs(
      optsForPreset('best', { ytDlpCommandOverride: 'yt-dlp -f best' }),
      DEPS,
    );
    expect(args.at(-1)).toBe('https://example.com/x');
  });

  it('falls through to auto mode when the override fails to parse', () => {
    const { args } = buildDownloadArgs(
      optsForPreset('best', { ytDlpCommandOverride: "yt-dlp -f 'unterminated" }),
      DEPS,
    );
    // Auto mode includes -N, format args, and the URL at the end.
    expect(args).toContain('-N');
    expect(args).toContain('-f');
    expect(args.at(-1)).toBe('https://example.com/x');
  });

  it('appends --video-password when the override did not pin one', () => {
    const { args } = buildDownloadArgs(
      optsForPreset('best', {
        ytDlpCommandOverride: 'yt-dlp -f best',
        videoPassword: 'sekret',
      }),
      DEPS,
    );
    expect(args).toContain('--video-password');
    expect(args[args.indexOf('--video-password') + 1]).toBe('sekret');
  });

  it("doesn't double-append --video-password when the override already supplies one", () => {
    const { args } = buildDownloadArgs(
      optsForPreset('best', {
        ytDlpCommandOverride: 'yt-dlp --video-password user-pw -f best',
        videoPassword: 'queue-pw',
      }),
      DEPS,
    );
    const occurrences = args.filter((a) => a === '--video-password').length;
    expect(occurrences).toBe(1);
  });

  it('still emits framework flags so progress + final-path tracking works', () => {
    const { args, markerPath } = buildDownloadArgs(
      optsForPreset('best', { ytDlpCommandOverride: 'yt-dlp -f best' }),
      DEPS,
    );
    expect(args).toContain('--progress-template');
    expect(args).toContain('--print-to-file');
    expect(args).toContain(markerPath);
    expect(args).toContain('--paths');
  });

  it('always emits --no-playlist so a playlist URL pasted into a single Download row never iterates the surrounding playlist', () => {
    // Auto mode AND override mode both run through the framework
    // block which pins --no-playlist. Guards against yt-dlp's default
    // playlist-iteration behavior for `playlist?list=Y` URLs.
    const auto = buildDownloadArgs(optsForPreset('best'), DEPS);
    expect(auto.args).toContain('--no-playlist');
    const override = buildDownloadArgs(
      optsForPreset('best', { ytDlpCommandOverride: 'yt-dlp -f best' }),
      DEPS,
    );
    expect(override.args).toContain('--no-playlist');
  });

  it('emits --sleep-requests <n> when requestSleepSeconds is set', () => {
    const { args } = buildDownloadArgs(optsForPreset('best', { requestSleepSeconds: 1 }), DEPS);
    const idx = args.indexOf('--sleep-requests');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('1');
  });

  it('omits --sleep-requests when requestSleepSeconds is unset, zero, or negative', () => {
    for (const value of [undefined, 0, -1]) {
      const opts =
        value === undefined
          ? optsForPreset('best')
          : optsForPreset('best', { requestSleepSeconds: value });
      const { args } = buildDownloadArgs(opts, DEPS);
      expect(args).not.toContain('--sleep-requests');
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
