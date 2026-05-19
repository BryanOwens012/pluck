import { describe, expect, it } from 'vitest';
import { STATIC_FORMAT_CHOICES } from '../shared/types';
import {
  ApiKeyCredentialsSchema,
  BrowserNameSchema,
  DownloadRequestSchema,
  FormatChoiceSchema,
  HttpUrlSchema,
  NonEmptyStringSchema,
  PlaylistContextSchema,
  PlaylistEntrySchema,
  PlaylistEntryShapeSchema,
  PlaylistOrderSchema,
  SecretNameSchema,
  StartPlaylistDownloadSchema,
  UpdateSettingsPatchSchema,
} from './ipc-schemas';

// ---- Atomic schemas ----------------------------------------------------

describe('HttpUrlSchema', () => {
  it('accepts http and https URLs', () => {
    expect(HttpUrlSchema.safeParse('https://youtube.com/watch?v=X').success).toBe(true);
    expect(HttpUrlSchema.safeParse('http://example.com').success).toBe(true);
  });

  it('rejects non-http schemes (defense-in-depth IPC guard)', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi']) {
      expect(HttpUrlSchema.safeParse(url).success).toBe(false);
    }
  });

  it('rejects bare strings without a scheme', () => {
    expect(HttpUrlSchema.safeParse('youtube.com/X').success).toBe(false);
    expect(HttpUrlSchema.safeParse('').success).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(HttpUrlSchema.safeParse(undefined).success).toBe(false);
    expect(HttpUrlSchema.safeParse(null).success).toBe(false);
    expect(HttpUrlSchema.safeParse(42).success).toBe(false);
  });
});

describe('NonEmptyStringSchema', () => {
  it('accepts a non-empty string', () => {
    expect(NonEmptyStringSchema.safeParse('hello').success).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(NonEmptyStringSchema.safeParse('').success).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(NonEmptyStringSchema.safeParse(undefined).success).toBe(false);
    expect(NonEmptyStringSchema.safeParse(0).success).toBe(false);
  });
});

describe('BrowserNameSchema', () => {
  it('accepts every BROWSER_NAMES value', () => {
    for (const name of ['chrome', 'firefox', 'safari', 'brave', 'edge']) {
      expect(BrowserNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('rejects unknown browser names', () => {
    expect(BrowserNameSchema.safeParse('opera').success).toBe(false);
    expect(BrowserNameSchema.safeParse('lynx').success).toBe(false);
  });
});

describe('SecretNameSchema', () => {
  it('accepts every SECRET_NAMES value', () => {
    for (const name of ['anthropic', 'elevenlabs']) {
      expect(SecretNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it('rejects unknown provider names', () => {
    expect(SecretNameSchema.safeParse('openai').success).toBe(false);
  });
});

describe('PlaylistOrderSchema', () => {
  it('accepts the two valid orderings', () => {
    expect(PlaylistOrderSchema.safeParse('oldest_first').success).toBe(true);
    expect(PlaylistOrderSchema.safeParse('newest_first').success).toBe(true);
  });

  it('rejects unknown orderings', () => {
    expect(PlaylistOrderSchema.safeParse('alphabetical').success).toBe(false);
    expect(PlaylistOrderSchema.safeParse('').success).toBe(false);
  });
});

// ---- Composite schemas -------------------------------------------------

describe('FormatChoiceSchema', () => {
  it('accepts a valid static FormatChoice', () => {
    expect(FormatChoiceSchema.safeParse(STATIC_FORMAT_CHOICES.best).success).toBe(true);
    expect(FormatChoiceSchema.safeParse(STATIC_FORMAT_CHOICES.audio_mp3).success).toBe(true);
  });

  it('rejects an unknown format id', () => {
    expect(
      FormatChoiceSchema.safeParse({
        id: 'unknown',
        label: 'X',
        ytDlpFormatArgs: [],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing ytDlpFormatArgs array', () => {
    expect(FormatChoiceSchema.safeParse({ id: 'best', label: 'Best' }).success).toBe(false);
  });

  it('accepts optional shorthand and detail fields', () => {
    expect(
      FormatChoiceSchema.safeParse({
        id: 'best',
        label: 'Best',
        shorthand: '4K',
        detail: '3840×2160 mp4, 60fps',
        ytDlpFormatArgs: ['-f', 'best'],
      }).success,
    ).toBe(true);
  });
});

describe('PlaylistContextSchema', () => {
  it('accepts a complete context', () => {
    expect(
      PlaylistContextSchema.safeParse({
        id: 'PLxxx',
        title: 'My Series',
        entryCount: 47,
        isExplicitPlaylistUrl: true,
      }).success,
    ).toBe(true);
  });

  it('accepts a context without entryCount', () => {
    expect(
      PlaylistContextSchema.safeParse({
        id: 'PLxxx',
        title: 'My Series',
        isExplicitPlaylistUrl: false,
      }).success,
    ).toBe(true);
  });

  it('rejects when isExplicitPlaylistUrl is missing', () => {
    expect(PlaylistContextSchema.safeParse({ id: 'PLxxx', title: 'X' }).success).toBe(false);
  });
});

describe('PlaylistEntrySchema (strict)', () => {
  it('accepts an entry with an http URL', () => {
    expect(
      PlaylistEntrySchema.safeParse({
        url: 'https://www.youtube.com/watch?v=v1',
        title: 'Episode One',
        index: 1,
      }).success,
    ).toBe(true);
  });

  it('rejects an entry with a non-http URL', () => {
    expect(
      PlaylistEntrySchema.safeParse({
        url: 'javascript:alert(1)',
        title: 'X',
        index: 1,
      }).success,
    ).toBe(false);
  });
});

describe('PlaylistEntryShapeSchema (loose, no URL check)', () => {
  it('accepts an entry with ANY string URL — handler does per-entry http check', () => {
    expect(
      PlaylistEntryShapeSchema.safeParse({
        url: 'javascript:alert(1)',
        title: 'X',
        index: 1,
      }).success,
    ).toBe(true);
  });

  it('still rejects a missing url field', () => {
    expect(PlaylistEntryShapeSchema.safeParse({ title: 'X', index: 1 }).success).toBe(false);
  });

  it('still rejects wrong types', () => {
    expect(PlaylistEntryShapeSchema.safeParse({ url: 42, title: 'X', index: 1 }).success).toBe(
      false,
    );
  });
});

describe('DownloadRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    expect(
      DownloadRequestSchema.safeParse({
        url: 'https://www.youtube.com/watch?v=X',
        format: STATIC_FORMAT_CHOICES.best,
      }).success,
    ).toBe(true);
  });

  it('accepts a full request with all optional fields', () => {
    expect(
      DownloadRequestSchema.safeParse({
        url: 'https://www.youtube.com/watch?v=X',
        format: STATIC_FORMAT_CHOICES.best,
        outputFolder: '/tmp/out',
        videoPassword: 'sekret',
        playlistId: 'PLxxx',
        playlistTitle: 'My Series',
        playlistIndex: 3,
        playlistTotal: 47,
      }).success,
    ).toBe(true);
  });

  it('rejects non-http URLs', () => {
    expect(
      DownloadRequestSchema.safeParse({
        url: 'file:///etc/passwd',
        format: STATIC_FORMAT_CHOICES.best,
      }).success,
    ).toBe(false);
  });

  it('rejects a missing format', () => {
    expect(DownloadRequestSchema.safeParse({ url: 'https://example.com/x' }).success).toBe(false);
  });
});

describe('StartPlaylistDownloadSchema', () => {
  const validEntry = (i: number) => ({
    url: `https://www.youtube.com/watch?v=v${i}`,
    title: `Episode ${i}`,
    index: i,
  });
  const validContext = {
    id: 'PLxxx',
    title: 'My Series',
    entryCount: 3,
    isExplicitPlaylistUrl: true,
  };

  it('accepts a complete valid payload', () => {
    expect(
      StartPlaylistDownloadSchema.safeParse({
        entries: [validEntry(1), validEntry(2), validEntry(3)],
        format: STATIC_FORMAT_CHOICES.best,
        playlistContext: validContext,
        order: 'oldest_first',
      }).success,
    ).toBe(true);
  });

  it('accepts entries with non-http URLs (loose entry schema; handler skips per-entry)', () => {
    // The schema lets this through; the handler's per-entry HttpUrlSchema
    // check filters bad URLs without failing the whole batch.
    expect(
      StartPlaylistDownloadSchema.safeParse({
        entries: [validEntry(1), { url: 'javascript:alert(1)', title: 'X', index: 2 }],
        format: STATIC_FORMAT_CHOICES.best,
        playlistContext: validContext,
        order: 'oldest_first',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty entries array', () => {
    expect(
      StartPlaylistDownloadSchema.safeParse({
        entries: [],
        format: STATIC_FORMAT_CHOICES.best,
        playlistContext: validContext,
        order: 'oldest_first',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown order value', () => {
    expect(
      StartPlaylistDownloadSchema.safeParse({
        entries: [validEntry(1)],
        format: STATIC_FORMAT_CHOICES.best,
        playlistContext: validContext,
        order: 'alphabetical',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing playlistContext', () => {
    expect(
      StartPlaylistDownloadSchema.safeParse({
        entries: [validEntry(1)],
        format: STATIC_FORMAT_CHOICES.best,
        order: 'oldest_first',
      }).success,
    ).toBe(false);
  });
});

describe('UpdateSettingsPatchSchema', () => {
  it('accepts an empty patch (no-op update)', () => {
    expect(UpdateSettingsPatchSchema.safeParse({}).success).toBe(true);
  });

  it('accepts every field set to a valid value', () => {
    expect(
      UpdateSettingsPatchSchema.safeParse({
        outputFolder: '/tmp/downloads',
        cookiesFromBrowser: 'chrome',
        debugMode: true,
        concurrentFragments: 8,
        concurrentDownloads: 3,
        ytDlpCommandOverride: 'yt-dlp -f best',
        developerSectionOpen: false,
      }).success,
    ).toBe(true);
  });

  it('accepts null for cookiesFromBrowser (explicit clear)', () => {
    expect(UpdateSettingsPatchSchema.safeParse({ cookiesFromBrowser: null }).success).toBe(true);
  });

  it('accepts null for ytDlpCommandOverride (explicit clear)', () => {
    expect(UpdateSettingsPatchSchema.safeParse({ ytDlpCommandOverride: null }).success).toBe(true);
  });

  it('rejects an empty outputFolder', () => {
    expect(UpdateSettingsPatchSchema.safeParse({ outputFolder: '' }).success).toBe(false);
  });

  it('rejects an unknown browser name', () => {
    expect(UpdateSettingsPatchSchema.safeParse({ cookiesFromBrowser: 'opera' }).success).toBe(
      false,
    );
  });

  it('rejects a non-integer concurrentFragments', () => {
    expect(UpdateSettingsPatchSchema.safeParse({ concurrentFragments: 2.5 }).success).toBe(false);
  });

  it('rejects concurrentFragments out of range', () => {
    expect(UpdateSettingsPatchSchema.safeParse({ concurrentFragments: 0 }).success).toBe(false);
    expect(UpdateSettingsPatchSchema.safeParse({ concurrentFragments: 999 }).success).toBe(false);
  });

  it('rejects concurrentDownloads out of range', () => {
    expect(UpdateSettingsPatchSchema.safeParse({ concurrentDownloads: 0 }).success).toBe(false);
    expect(UpdateSettingsPatchSchema.safeParse({ concurrentDownloads: 999 }).success).toBe(false);
  });
});

describe('ApiKeyCredentialsSchema', () => {
  it('accepts a valid (name, key) pair', () => {
    expect(ApiKeyCredentialsSchema.safeParse({ name: 'anthropic', key: 'sk-...' }).success).toBe(
      true,
    );
  });

  it('rejects an unknown provider name', () => {
    expect(ApiKeyCredentialsSchema.safeParse({ name: 'openai', key: 'sk-...' }).success).toBe(
      false,
    );
  });

  it('rejects an empty key', () => {
    expect(ApiKeyCredentialsSchema.safeParse({ name: 'anthropic', key: '' }).success).toBe(false);
  });

  it('rejects when name is missing', () => {
    expect(ApiKeyCredentialsSchema.safeParse({ key: 'sk-...' }).success).toBe(false);
  });
});
