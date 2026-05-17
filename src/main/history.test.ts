import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Download } from '../shared/types';
import { capToMax, createHistoryStore, promoteInterruptedToFailed } from './history';

const makeDownload = (overrides: Partial<Download> = {}): Download => ({
  id: 'youtube-x-20260516-204530-aaa111',
  url: 'https://youtube.com/watch?v=x',
  format: 'best',
  outputFolder: '/tmp/out',
  status: 'completed',
  progress: 100,
  createdAt: 1_700_000_000_000,
  ...overrides,
});

describe('capToMax', () => {
  it('returns the input unchanged when under the cap', () => {
    const items = [makeDownload({ id: 'a' }), makeDownload({ id: 'b' })];
    expect(capToMax(items, 50)).toEqual(items);
  });

  it('drops oldest by createdAt when over the cap', () => {
    const items = [
      makeDownload({ id: 'old', createdAt: 100 }),
      makeDownload({ id: 'mid', createdAt: 200 }),
      makeDownload({ id: 'new', createdAt: 300 }),
    ];
    expect(capToMax(items, 2).map((d) => d.id)).toEqual(['mid', 'new']);
  });

  it('keeps exactly `max` entries when input equals the cap', () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      makeDownload({ id: `id-${i}`, createdAt: i }),
    );
    expect(capToMax(items, 50)).toHaveLength(50);
  });

  it('drops the right ones when many over the cap', () => {
    const items = Array.from({ length: 60 }, (_, i) =>
      makeDownload({ id: `id-${i}`, createdAt: i }),
    );
    const result = capToMax(items, 50);
    expect(result).toHaveLength(50);
    expect(result[0]?.id).toBe('id-10');
    expect(result[49]?.id).toBe('id-59');
  });
});

describe('promoteInterruptedToFailed', () => {
  it('rewrites downloading → failed with the interrupted message', () => {
    const result = promoteInterruptedToFailed(
      makeDownload({ status: 'downloading', progress: 42, speed: '5.2 MB/s', eta: '00:30' }),
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Interrupted by app exit.');
    expect(result.speed).toBeUndefined();
    expect(result.eta).toBeUndefined();
  });

  it('rewrites queued → failed (would have started but never got a chance)', () => {
    const result = promoteInterruptedToFailed(makeDownload({ status: 'queued' }));
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Interrupted by app exit.');
  });

  it('passes terminal statuses through untouched', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const input = makeDownload({ status });
      expect(promoteInterruptedToFailed(input)).toBe(input);
    }
  });

  it('does NOT clobber an existing failed error message', () => {
    const original = makeDownload({ status: 'failed', error: 'real yt-dlp error' });
    expect(promoteInterruptedToFailed(original).error).toBe('real yt-dlp error');
  });
});

describe('createHistoryStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'pluck-history-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns [] on first run (file does not exist)', async () => {
    const store = createHistoryStore(dir);
    expect(await store.load()).toEqual([]);
  });

  it('round-trips downloads through save → load', async () => {
    const store = createHistoryStore(dir);
    const items = [makeDownload({ id: 'a' }), makeDownload({ id: 'b' })];
    await store.save(items);
    const loaded = await store.load();
    expect(loaded.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('uses an atomic write (sibling .tmp + rename)', async () => {
    const store = createHistoryStore(dir);
    // Spy on rename to confirm the atomic-rename path is taken rather than
    // a direct overwrite — the difference matters under power loss.
    const renameSpy = vi.spyOn(fs, 'rename');
    await store.save([makeDownload()]);
    expect(renameSpy).toHaveBeenCalledOnce();
    const [from, to] = renameSpy.mock.calls[0] ?? [];
    expect(from).toMatch(/history\.json\.tmp$/);
    expect(to).toMatch(/history\.json$/);
    renameSpy.mockRestore();
  });

  it('persists with version: 1 schema', async () => {
    const store = createHistoryStore(dir);
    await store.save([makeDownload()]);
    const raw = await fs.readFile(join(dir, 'history.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.downloads)).toBe(true);
  });

  it('returns [] and logs on corrupt JSON, does not throw', async () => {
    await fs.writeFile(join(dir, 'history.json'), '{not valid json', 'utf-8');
    const store = createHistoryStore(dir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store.load()).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('returns [] on a schema-mismatched file (wrong version, missing downloads)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await fs.writeFile(
      join(dir, 'history.json'),
      JSON.stringify({ version: 999, downloads: [] }),
      'utf-8',
    );
    expect(await createHistoryStore(dir).load()).toEqual([]);

    await fs.writeFile(join(dir, 'history.json'), JSON.stringify({ version: 1 }), 'utf-8');
    expect(await createHistoryStore(dir).load()).toEqual([]);

    errorSpy.mockRestore();
  });

  it('caps at 50 entries on save', async () => {
    const store = createHistoryStore(dir);
    const items = Array.from({ length: 75 }, (_, i) =>
      makeDownload({ id: `id-${i}`, createdAt: i }),
    );
    await store.save(items);
    const loaded = await store.load();
    expect(loaded).toHaveLength(50);
    expect(loaded[0]?.id).toBe('id-25');
  });

  it('rewrites interrupted rows on load (crash recovery)', async () => {
    const store = createHistoryStore(dir);
    await store.save([
      makeDownload({ id: 'survivor', status: 'completed' }),
      makeDownload({ id: 'crash-victim', status: 'downloading', progress: 42 }),
      makeDownload({ id: 'never-ran', status: 'queued' }),
    ]);
    const loaded = await store.load();
    expect(loaded.find((d) => d.id === 'survivor')?.status).toBe('completed');
    expect(loaded.find((d) => d.id === 'crash-victim')?.status).toBe('failed');
    expect(loaded.find((d) => d.id === 'never-ran')?.status).toBe('failed');
  });

  it('creates parent directories on save if missing', async () => {
    const nested = join(dir, 'a', 'b', 'c');
    const store = createHistoryStore(nested);
    await store.save([makeDownload()]);
    expect((await fs.stat(join(nested, 'history.json'))).isFile()).toBe(true);
  });
});
