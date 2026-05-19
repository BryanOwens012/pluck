import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock `electron` BEFORE importing anything that pulls it in. ipc.ts
// calls `ipcMain.handle(...)` at module-init time inside
// `registerIpcHandlers`; the mock captures each handler so the tests
// below can invoke them with a synthetic payload.
type Handler = (event: unknown, payload: unknown) => unknown;
const handlersByChannel = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler): void => {
      handlersByChannel.set(channel, handler);
    },
  },
  // App + dialog + shell are referenced by registerIpcHandlers for
  // OpenTempFolder + ChooseOutputFolder / etc. Stub them so the
  // module loads cleanly under the test env (no real Electron).
  app: { getPath: (): string => '/tmp/userdata' },
  dialog: { showOpenDialog: vi.fn() },
  shell: {
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(),
    openPath: vi.fn(),
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
}));

import { IpcChannels } from '../shared/ipc-channels';
import {
  type DownloadRequest,
  type PlaylistContext,
  type PlaylistEntry,
  STATIC_FORMAT_CHOICES,
} from '../shared/types';
import { generateDownloadId, registerIpcHandlers } from './ipc';

// ---- existing pure-helper coverage -------------------------------------

describe('generateDownloadId', () => {
  const FIXED_NOW = new Date('2026-05-16T20:45:30');

  it('uses the YouTube ?v= param as the slug', () => {
    const id = generateDownloadId('https://www.youtube.com/watch?v=jNQXAC9IVRw', FIXED_NOW);
    expect(id).toBe(`youtube-jNQXAC9IVRw-20260516-204530-${id.split('-').at(-1)}`);
    expect(id).toMatch(/^youtube-jNQXAC9IVRw-20260516-204530-[a-z0-9]{1,6}$/);
  });

  it('uses the last path segment when no ?v= is present (Vimeo, Zoom)', () => {
    expect(generateDownloadId('https://vimeo.com/12345', FIXED_NOW)).toMatch(
      /^vimeo-12345-20260516-204530-[a-z0-9]{1,6}$/,
    );
    expect(generateDownloadId('https://zoom.us/rec/play/abc123', FIXED_NOW)).toMatch(
      /^zoom-abc123-20260516-204530-[a-z0-9]{1,6}$/,
    );
  });

  it('strips a leading www. from the hostname', () => {
    expect(generateDownloadId('https://www.vimeo.com/999', FIXED_NOW)).toMatch(/^vimeo-999-/);
  });

  it('sanitizes filesystem-unsafe characters and clips long segments', () => {
    const id = generateDownloadId(
      'https://example.com/very/deep/path/with-some_weird@chars.and!stuff.mp4',
      FIXED_NOW,
    );
    expect(id).toMatch(/^example-/);
    expect(id).not.toMatch(/[!@]/);
    const slug = id.split('-20260516')[0] ?? '';
    expect(slug.length).toBeLessThanOrEqual(30 + 'example-'.length);
  });

  it('falls back to "download" for malformed URLs', () => {
    expect(generateDownloadId('not a url', FIXED_NOW)).toMatch(
      /^download-20260516-204530-[a-z0-9]{1,6}$/,
    );
    expect(generateDownloadId('', FIXED_NOW)).toMatch(/^download-/);
  });

  it('falls back to just the hostname for URLs with no path or query', () => {
    expect(generateDownloadId('https://youtube.com/', FIXED_NOW)).toMatch(
      /^youtube-20260516-204530-[a-z0-9]{1,6}$/,
    );
  });

  it('produces distinct ids across rapid successive calls (same URL, same second)', () => {
    const ids = new Set(
      Array.from({ length: 64 }, () =>
        generateDownloadId('https://youtube.com/watch?v=jNQXAC9IVRw', FIXED_NOW),
      ),
    );
    expect(ids.size).toBe(64);
  });

  it('embeds the actual current time when no Date is passed', () => {
    const before = Date.now();
    const id = generateDownloadId('https://youtube.com/watch?v=x');
    const after = Date.now();
    const stampMatch = id.match(/-(\d{8})-(\d{6})-/);
    expect(stampMatch).not.toBeNull();
    if (stampMatch) {
      const [, ymd, hms] = stampMatch;
      const y = Number(ymd?.slice(0, 4));
      const mo = Number(ymd?.slice(4, 6)) - 1;
      const d = Number(ymd?.slice(6, 8));
      const h = Number(hms?.slice(0, 2));
      const mi = Number(hms?.slice(2, 4));
      const s = Number(hms?.slice(4, 6));
      const parsed = new Date(y, mo, d, h, mi, s).getTime();
      expect(parsed).toBeGreaterThanOrEqual(before - 1000);
      expect(parsed).toBeLessThanOrEqual(after + 1000);
    }
  });
});

// ---- StartPlaylistDownload IPC handler ---------------------------------

/** Capture every `queue.enqueue` call so each test can assert on the
 * playlist fields that landed on the request. Reset between tests. */
let enqueueCalls: DownloadRequest[];

const buildFakeDeps = (): Parameters<typeof registerIpcHandlers>[0] => {
  enqueueCalls = [];
  return {
    queue: {
      enqueue: (request: DownloadRequest): string => {
        enqueueCalls.push(request);
        return `id-${enqueueCalls.length}`;
      },
      cancel: vi.fn(),
      submitPassword: vi.fn(),
      getAll: (): never[] => [],
      rehydrate: vi.fn(),
    },
    metadataCache: { get: vi.fn(), prefetch: vi.fn(), size: (): number => 0 },
    settings: {
      get: vi.fn(),
      update: vi.fn(),
    } as unknown as Parameters<typeof registerIpcHandlers>[0]['settings'],
    secrets: {} as Parameters<typeof registerIpcHandlers>[0]['secrets'],
    tempBaseDir: '/tmp/pluck-cache',
    enumeratePlaylist: vi.fn(),
  };
};

const invokeStartPlaylistDownload = (payload: unknown): unknown => {
  const handler = handlersByChannel.get(IpcChannels.StartPlaylistDownload);
  if (!handler) {
    throw new Error('StartPlaylistDownload handler not registered');
  }
  return handler({}, payload);
};

const fakeEntry = (id: string, index: number): PlaylistEntry => ({
  url: `https://www.youtube.com/watch?v=${id}`,
  title: `Episode ${index}`,
  index,
});

const fakeContext: PlaylistContext = {
  id: 'PLZbbT5o_s2xr17PqeytCKiCD',
  title: 'Coinbase Trading Series',
  entryCount: 3,
  isExplicitPlaylistUrl: true,
};

describe('StartPlaylistDownload IPC handler', () => {
  beforeEach(() => {
    handlersByChannel.clear();
    registerIpcHandlers(buildFakeDeps());
  });

  it('enqueues every entry with playlistId / playlistTitle / playlistIndex / playlistTotal set from the context', () => {
    invokeStartPlaylistDownload({
      entries: [fakeEntry('v1', 1), fakeEntry('v2', 2), fakeEntry('v3', 3)],
      format: STATIC_FORMAT_CHOICES.best,
      playlistContext: fakeContext,
      order: 'oldest_first',
    });

    expect(enqueueCalls).toHaveLength(3);
    expect(enqueueCalls).toEqual([
      expect.objectContaining({
        url: 'https://www.youtube.com/watch?v=v1',
        playlistId: 'PLZbbT5o_s2xr17PqeytCKiCD',
        playlistTitle: 'Coinbase Trading Series',
        playlistIndex: 1,
        playlistTotal: 3,
      }),
      expect.objectContaining({
        url: 'https://www.youtube.com/watch?v=v2',
        playlistId: 'PLZbbT5o_s2xr17PqeytCKiCD',
        playlistTitle: 'Coinbase Trading Series',
        playlistIndex: 2,
        playlistTotal: 3,
      }),
      expect.objectContaining({
        url: 'https://www.youtube.com/watch?v=v3',
        playlistId: 'PLZbbT5o_s2xr17PqeytCKiCD',
        playlistTitle: 'Coinbase Trading Series',
        playlistIndex: 3,
        playlistTotal: 3,
      }),
    ]);
  });

  it('reverses entries when order=newest_first and re-numbers indices 1..N along the reversed order', () => {
    // The user picked "All videos (newest to oldest)" — the file
    // prefixes should count up in REVERSED playlist order so the
    // newest video is "01" in the resulting folder. This matches
    // user expectation that the prefix is the position in their
    // chosen ordering, not the canonical playlist order.
    invokeStartPlaylistDownload({
      entries: [fakeEntry('v1', 1), fakeEntry('v2', 2), fakeEntry('v3', 3)],
      format: STATIC_FORMAT_CHOICES.best,
      playlistContext: fakeContext,
      order: 'newest_first',
    });

    expect(enqueueCalls.map((r) => ({ url: r.url, playlistIndex: r.playlistIndex }))).toEqual([
      { url: 'https://www.youtube.com/watch?v=v3', playlistIndex: 1 },
      { url: 'https://www.youtube.com/watch?v=v2', playlistIndex: 2 },
      { url: 'https://www.youtube.com/watch?v=v1', playlistIndex: 3 },
    ]);
  });

  it('skips entries with a non-http URL (defense-in-depth against bad enumerate output)', () => {
    invokeStartPlaylistDownload({
      entries: [
        fakeEntry('v1', 1),
        { url: 'javascript:alert(1)', title: 'evil', index: 2 },
        fakeEntry('v3', 3),
      ],
      format: STATIC_FORMAT_CHOICES.best,
      playlistContext: fakeContext,
      order: 'oldest_first',
    });

    expect(enqueueCalls.map((r) => r.url)).toEqual([
      'https://www.youtube.com/watch?v=v1',
      'https://www.youtube.com/watch?v=v3',
    ]);
  });

  it('bails (zero enqueues) on missing playlistContext', () => {
    invokeStartPlaylistDownload({
      entries: [fakeEntry('v1', 1)],
      format: STATIC_FORMAT_CHOICES.best,
      // playlistContext omitted
      order: 'oldest_first',
    });
    expect(enqueueCalls).toEqual([]);
  });

  it('bails (zero enqueues) on missing format', () => {
    invokeStartPlaylistDownload({
      entries: [fakeEntry('v1', 1)],
      // format omitted
      playlistContext: fakeContext,
      order: 'oldest_first',
    });
    expect(enqueueCalls).toEqual([]);
  });

  it('bails (zero enqueues) on a non-object payload', () => {
    invokeStartPlaylistDownload(null);
    expect(enqueueCalls).toEqual([]);
    invokeStartPlaylistDownload('not a payload');
    expect(enqueueCalls).toEqual([]);
  });

  it('bails (zero enqueues) on an empty entries array even with valid format + context', () => {
    // Defense in depth: an empty enumerate result (deleted playlist,
    // region-locked, etc.) shouldn't produce zero-row enqueues that
    // then immediately do nothing. Renderer guards against this too;
    // this confirms the IPC handler stays consistent.
    invokeStartPlaylistDownload({
      entries: [],
      format: STATIC_FORMAT_CHOICES.best,
      playlistContext: fakeContext,
      order: 'oldest_first',
    });
    expect(enqueueCalls).toEqual([]);
  });
});

describe('StartDownload IPC handler URL guard', () => {
  beforeEach(() => {
    handlersByChannel.clear();
    registerIpcHandlers(buildFakeDeps());
  });

  const invokeStartDownload = (payload: unknown): unknown => {
    const handler = handlersByChannel.get(IpcChannels.StartDownload);
    if (!handler) {
      throw new Error('StartDownload handler not registered');
    }
    return handler({}, payload);
  };

  it('enqueues a request with a valid https URL', () => {
    const result = invokeStartDownload({
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      format: STATIC_FORMAT_CHOICES.best,
    });
    expect(result).toEqual({ id: 'id-1' });
    expect(enqueueCalls).toHaveLength(1);
  });

  it('rejects (no enqueue) non-http schemes — file:// / javascript: / data:', () => {
    // Defense in depth: the renderer normalizes + validates before
    // calling, but a compromised renderer could otherwise sneak
    // these past and have the queue try to spawn yt-dlp on them.
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com/x',
    ]) {
      const result = invokeStartDownload({ url, format: STATIC_FORMAT_CHOICES.best });
      expect(result).toEqual({ error: 'Invalid URL.' });
    }
    expect(enqueueCalls).toEqual([]);
  });

  it('rejects (no enqueue) when url is missing / wrong type / empty', () => {
    for (const url of [undefined, null, 42, '', 'not a url']) {
      const result = invokeStartDownload({ url, format: STATIC_FORMAT_CHOICES.best });
      expect(result).toEqual({ error: 'Invalid URL.' });
    }
    expect(enqueueCalls).toEqual([]);
  });

  it('rejects (no enqueue) on a non-object payload', () => {
    expect(invokeStartDownload(null)).toEqual({ error: 'Invalid URL.' });
    expect(invokeStartDownload('not a payload')).toEqual({ error: 'Invalid URL.' });
    expect(enqueueCalls).toEqual([]);
  });
});
