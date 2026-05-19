import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore, defaultOutputFolder } from './settings';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'pluck-settings-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('defaultOutputFolder', () => {
  it('is ~/Downloads/Pluck', () => {
    expect(defaultOutputFolder()).toMatch(/Downloads\/Pluck$/);
  });
});

describe('createSettingsStore', () => {
  it('returns defaults on first run (file does not exist)', async () => {
    const store = await createSettingsStore(dir);
    expect(store.get().outputFolder).toBe(defaultOutputFolder());
  });

  it('round-trips an updated value through update → fresh store load', async () => {
    const a = await createSettingsStore(dir);
    await a.update({ outputFolder: '/tmp/custom' });
    expect(a.get().outputFolder).toBe('/tmp/custom');

    const b = await createSettingsStore(dir);
    expect(b.get().outputFolder).toBe('/tmp/custom');
  });

  it('round-trips cookiesFromBrowser (chrome) through update → reload', async () => {
    const a = await createSettingsStore(dir);
    await a.update({ cookiesFromBrowser: 'chrome' });
    expect(a.get().cookiesFromBrowser).toBe('chrome');

    const b = await createSettingsStore(dir);
    expect(b.get().cookiesFromBrowser).toBe('chrome');
    // outputFolder default still applied via defaults-spread.
    expect(b.get().outputFolder).toBe(defaultOutputFolder());
  });

  it('clearing cookiesFromBrowser (set to undefined) drops it from the snapshot', async () => {
    const a = await createSettingsStore(dir);
    await a.update({ cookiesFromBrowser: 'firefox' });
    await a.update({ cookiesFromBrowser: undefined });
    expect(a.get().cookiesFromBrowser).toBeUndefined();
  });

  it('clear persists across reload (next boot sees no cookies setting)', async () => {
    // Regression guard for the IPC "clear" path: setting then clearing
    // a value must survive a fresh load. If the store skipped the disk
    // write on undefined (e.g. treating it as "no change"), the next
    // store would still see 'firefox' — that bug bit us once already.
    const a = await createSettingsStore(dir);
    await a.update({ cookiesFromBrowser: 'firefox' });
    await a.update({ cookiesFromBrowser: undefined });

    const b = await createSettingsStore(dir);
    expect(b.get().cookiesFromBrowser).toBeUndefined();
  });

  it('debugMode defaults to false on first run', async () => {
    const store = await createSettingsStore(dir);
    expect(store.get().debugMode).toBe(false);
  });

  it('round-trips debugMode through update → reload', async () => {
    const a = await createSettingsStore(dir);
    await a.update({ debugMode: true });
    expect(a.get().debugMode).toBe(true);

    const b = await createSettingsStore(dir);
    expect(b.get().debugMode).toBe(true);
  });

  it('settings.json missing debugMode loads as debugMode: false', async () => {
    // A partially-written or hand-edited file may omit debugMode
    // key. The defaults-spread in createSettingsStore should fill it
    // in as false rather than carrying `undefined` forward.
    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, settings: { outputFolder: '/tmp/x' } }),
      'utf-8',
    );
    const store = await createSettingsStore(dir);
    expect(store.get().debugMode).toBe(false);
    expect(store.get().outputFolder).toBe('/tmp/x');
  });

  it('rejects a settings file with a non-boolean debugMode', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, settings: { outputFolder: '/tmp/x', debugMode: 'yes' } }),
      'utf-8',
    );
    const store = await createSettingsStore(dir);
    expect(store.get().debugMode).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('concurrentFragments defaults to 14 on first run', async () => {
    const store = await createSettingsStore(dir);
    expect(store.get().concurrentFragments).toBe(14);
  });

  it('round-trips concurrentFragments through update → reload', async () => {
    const a = await createSettingsStore(dir);
    await a.update({ concurrentFragments: 8 });
    expect(a.get().concurrentFragments).toBe(8);

    const b = await createSettingsStore(dir);
    expect(b.get().concurrentFragments).toBe(8);
  });

  it('rejects a settings file with concurrentFragments out of range', async () => {
    // Range is 1-20 (inclusive). 0, 21, 100, negatives, non-integers
    // all fail validation; the file is rejected and defaults apply.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of [0, 21, 100, -1, 3.5]) {
      await fs.writeFile(
        join(dir, 'settings.json'),
        JSON.stringify({
          version: 1,
          settings: { outputFolder: '/tmp/x', concurrentFragments: bad },
        }),
        'utf-8',
      );
      const store = await createSettingsStore(dir);
      // Falls back to default (14) — invalid file → defaults spread.
      expect(store.get().concurrentFragments).toBe(14);
    }
    errorSpy.mockRestore();
  });

  it('settings.json missing concurrentFragments loads as default 14', async () => {
    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, settings: { outputFolder: '/tmp/x' } }),
      'utf-8',
    );
    const store = await createSettingsStore(dir);
    expect(store.get().concurrentFragments).toBe(14);
  });

  it('concurrentDownloads defaults to 3 on first run', async () => {
    const store = await createSettingsStore(dir);
    expect(store.get().concurrentDownloads).toBe(3);
  });

  it('round-trips concurrentDownloads through update → reload', async () => {
    const a = await createSettingsStore(dir);
    await a.update({ concurrentDownloads: 5 });
    expect(a.get().concurrentDownloads).toBe(5);

    const b = await createSettingsStore(dir);
    expect(b.get().concurrentDownloads).toBe(5);
  });

  it('rejects a settings file with concurrentDownloads out of range', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of [0, 11, 50, -1, 2.5]) {
      await fs.writeFile(
        join(dir, 'settings.json'),
        JSON.stringify({
          version: 1,
          settings: { outputFolder: '/tmp/x', concurrentDownloads: bad },
        }),
        'utf-8',
      );
      const store = await createSettingsStore(dir);
      expect(store.get().concurrentDownloads).toBe(3);
    }
    errorSpy.mockRestore();
  });

  it('accepts concurrentFragments up to 20 (new max)', async () => {
    // Bumped from the previous 1-16 cap. A user setting 20 should
    // round-trip cleanly; 21 should fall back to default.
    const a = await createSettingsStore(dir);
    await a.update({ concurrentFragments: 20 });
    expect(a.get().concurrentFragments).toBe(20);
  });

  it('rejects a settings file with an invalid cookiesFromBrowser value', async () => {
    // Hand-edited typo or schema drift — must fall back to defaults
    // rather than silently passing `--cookies-from-browser banana` to
    // yt-dlp on the next download.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        settings: { outputFolder: '/tmp/x', cookiesFromBrowser: 'banana' },
      }),
      'utf-8',
    );
    const store = await createSettingsStore(dir);
    expect(store.get().outputFolder).toBe(defaultOutputFolder());
    expect(store.get().cookiesFromBrowser).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('uses an atomic write (sibling .tmp + rename)', async () => {
    const store = await createSettingsStore(dir);
    const renameSpy = vi.spyOn(fs, 'rename');
    await store.update({ outputFolder: '/tmp/x' });
    expect(renameSpy).toHaveBeenCalledOnce();
    const [from, to] = renameSpy.mock.calls[0] ?? [];
    expect(from).toMatch(/settings\.json\.tmp$/);
    expect(to).toMatch(/settings\.json$/);
    renameSpy.mockRestore();
  });

  it('persists with version: 1 schema', async () => {
    const store = await createSettingsStore(dir);
    await store.update({ outputFolder: '/tmp/x' });
    const raw = await fs.readFile(join(dir, 'settings.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.settings.outputFolder).toBe('/tmp/x');
  });

  it('falls back to defaults on corrupt JSON, does not throw', async () => {
    await fs.writeFile(join(dir, 'settings.json'), '{not valid json', 'utf-8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = await createSettingsStore(dir);
    expect(store.get().outputFolder).toBe(defaultOutputFolder());
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('falls back to defaults on schema mismatch (wrong version / missing key)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 999, settings: { outputFolder: '/tmp/x' } }),
      'utf-8',
    );
    expect((await createSettingsStore(dir)).get().outputFolder).toBe(defaultOutputFolder());

    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, settings: {} }),
      'utf-8',
    );
    expect((await createSettingsStore(dir)).get().outputFolder).toBe(defaultOutputFolder());

    errorSpy.mockRestore();
  });

  it('update() returns the post-update snapshot', async () => {
    const store = await createSettingsStore(dir);
    const result = await store.update({ outputFolder: '/tmp/x' });
    expect(result.outputFolder).toBe('/tmp/x');
  });

  it('update() merges (other keys preserved when only one is patched)', async () => {
    // Only one writable key today, but the merge semantic matters for
    // future settings — verify update doesn't blow away unspecified keys.
    const store = await createSettingsStore(dir);
    await store.update({ outputFolder: '/tmp/x' });
    await store.update({});
    expect(store.get().outputFolder).toBe('/tmp/x');
  });

  it('update() does not commit to memory on disk failure', async () => {
    const store = await createSettingsStore(dir);
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.update({ outputFolder: '/tmp/x' })).rejects.toThrow('disk full');
    // In-memory snapshot stayed at the default — rename failed before
    // the local current = next; assignment ran.
    expect(store.get().outputFolder).toBe(defaultOutputFolder());
    renameSpy.mockRestore();
  });

  it('creates parent directories on update if missing', async () => {
    const nested = join(dir, 'a', 'b', 'c');
    const store = await createSettingsStore(nested);
    await store.update({ outputFolder: '/tmp/x' });
    expect((await fs.stat(join(nested, 'settings.json'))).isFile()).toBe(true);
  });

  it('round-trips ytDlpCommandOverride through update → reload', async () => {
    const store = await createSettingsStore(dir);
    await store.update({ ytDlpCommandOverride: 'yt-dlp -f best <URL>' });
    const reloaded = await createSettingsStore(dir);
    expect(reloaded.get().ytDlpCommandOverride).toBe('yt-dlp -f best <URL>');
  });

  it('clears ytDlpCommandOverride when set to undefined', async () => {
    const store = await createSettingsStore(dir);
    await store.update({ ytDlpCommandOverride: 'yt-dlp -f best' });
    await store.update({ ytDlpCommandOverride: undefined });
    expect(store.get().ytDlpCommandOverride).toBeUndefined();
  });

  it('accepts arbitrary text (no content validation at the storage layer)', async () => {
    // Validation happens at use time via the tokenizer — the storage
    // layer accepts any string so users can save partial / in-progress
    // commands without the schema check bouncing the file.
    const store = await createSettingsStore(dir);
    await store.update({ ytDlpCommandOverride: "yt-dlp -f 'unterminated" });
    const reloaded = await createSettingsStore(dir);
    expect(reloaded.get().ytDlpCommandOverride).toBe("yt-dlp -f 'unterminated");
  });

  it('round-trips developerSectionOpen through update → reload', async () => {
    const store = await createSettingsStore(dir);
    expect(store.get().developerSectionOpen).toBe(false); // default
    await store.update({ developerSectionOpen: true });
    const reloaded = await createSettingsStore(dir);
    expect(reloaded.get().developerSectionOpen).toBe(true);
  });

  it('defaults developerSectionOpen to false when missing from disk', async () => {
    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ version: 1, settings: { outputFolder: '/tmp/x' } }),
      'utf-8',
    );
    const store = await createSettingsStore(dir);
    expect(store.get().developerSectionOpen).toBe(false);
  });

  it('rejects a non-string ytDlpCommandOverride at the schema layer', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await fs.writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        version: 1,
        settings: { outputFolder: '/tmp/x', ytDlpCommandOverride: 42 },
      }),
      'utf-8',
    );
    const store = await createSettingsStore(dir);
    // Schema mismatch → defaults take over; outputFolder reverts to
    // the system default rather than honoring the malformed file.
    expect(store.get().ytDlpCommandOverride).toBeUndefined();
    expect(store.get().outputFolder).toBe(defaultOutputFolder());
    errorSpy.mockRestore();
  });
});
