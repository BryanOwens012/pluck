import { beforeEach, describe, expect, it } from 'vitest';
import type { Download } from '../../../shared/types';
import { selectRows, useDownloadsStore } from './downloads';

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

beforeEach(() => {
  // Zustand's create() returns a singleton store; reset between tests so
  // state from one test doesn't bleed into the next.
  useDownloadsStore.setState({ downloads: new Map() });
});

describe('useDownloadsStore.upsert', () => {
  it('adds a new row', () => {
    useDownloadsStore.getState().upsert(makeDownload({ id: 'a' }));
    expect(useDownloadsStore.getState().downloads.size).toBe(1);
    expect(useDownloadsStore.getState().downloads.get('a')?.id).toBe('a');
  });

  it('replaces an existing row by id', () => {
    useDownloadsStore.getState().upsert(makeDownload({ id: 'a', progress: 10 }));
    useDownloadsStore.getState().upsert(makeDownload({ id: 'a', progress: 90 }));
    expect(useDownloadsStore.getState().downloads.get('a')?.progress).toBe(90);
  });

  it('returns a new Map reference so Zustand re-renders subscribers', () => {
    const before = useDownloadsStore.getState().downloads;
    useDownloadsStore.getState().upsert(makeDownload({ id: 'a' }));
    expect(useDownloadsStore.getState().downloads).not.toBe(before);
  });
});

describe('useDownloadsStore.seed', () => {
  it('fills an empty store with the snapshot', () => {
    useDownloadsStore.getState().seed([makeDownload({ id: 'a' }), makeDownload({ id: 'b' })]);
    expect(useDownloadsStore.getState().downloads.size).toBe(2);
  });

  it('keeps existing rows (newer-push-wins) when seeding after a race', () => {
    // Simulates: subscribe → push update arrives (upsert) → seed resolves
    // with the OLDER snapshot from main. The pushed row was the newer
    // truth, so seed must NOT clobber it.
    useDownloadsStore.getState().upsert(makeDownload({ id: 'race', progress: 99 }));
    useDownloadsStore.getState().seed([makeDownload({ id: 'race', progress: 10 })]);
    expect(useDownloadsStore.getState().downloads.get('race')?.progress).toBe(99);
  });

  it('adds rows from seed that were not already in the store', () => {
    useDownloadsStore.getState().upsert(makeDownload({ id: 'live', progress: 50 }));
    useDownloadsStore
      .getState()
      .seed([makeDownload({ id: 'live', progress: 1 }), makeDownload({ id: 'historic' })]);
    const downloads = useDownloadsStore.getState().downloads;
    expect(downloads.get('live')?.progress).toBe(50); // existing wins
    expect(downloads.get('historic')).toBeDefined(); // unknown id from seed lands
  });

  it('is a no-op on an empty seed call', () => {
    useDownloadsStore.getState().upsert(makeDownload({ id: 'a' }));
    useDownloadsStore.getState().seed([]);
    expect(useDownloadsStore.getState().downloads.size).toBe(1);
  });
});

describe('selectRows', () => {
  it('returns rows sorted newest-first by createdAt', () => {
    useDownloadsStore
      .getState()
      .seed([
        makeDownload({ id: 'old', createdAt: 100 }),
        makeDownload({ id: 'new', createdAt: 300 }),
        makeDownload({ id: 'mid', createdAt: 200 }),
      ]);
    expect(selectRows(useDownloadsStore.getState()).map((d) => d.id)).toEqual([
      'new',
      'mid',
      'old',
    ]);
  });

  it('returns [] when the store is empty', () => {
    expect(selectRows(useDownloadsStore.getState())).toEqual([]);
  });
});
