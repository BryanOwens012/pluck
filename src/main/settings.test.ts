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
});
