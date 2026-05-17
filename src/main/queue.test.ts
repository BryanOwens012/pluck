import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Download, DownloadRequest } from '../shared/types';
import type { MetadataCache } from './metadata-cache';
import { createDownloadQueue, friendlyErrorMessage, padToMinDuration } from './queue';
import type {
  RunDownloadOptions,
  RunDownloadResult,
  RunnerDeps,
  VideoMetadata,
} from './ytdlp/types';
import { YtDlpCancelledError, YtDlpError, YtDlpPasswordRequiredError } from './ytdlp/types';

// ---- pure-helper coverage ----------------------------------------------

describe('padToMinDuration', () => {
  const TOLERANCE_MS = 50;

  it('returns immediately when the minimum has already elapsed', async () => {
    const t0 = Date.now();
    await padToMinDuration(Date.now() - 1000, 500);
    expect(Date.now() - t0).toBeLessThan(TOLERANCE_MS);
  });

  it('sleeps the remainder when the minimum has not elapsed', async () => {
    const start = Date.now();
    await padToMinDuration(start, 200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(200 + TOLERANCE_MS);
  });
});

describe('friendlyErrorMessage', () => {
  it('maps YtDlpCancelledError to a non-scary cancellation string', () => {
    expect(friendlyErrorMessage(new YtDlpCancelledError())).toBe('Download cancelled.');
  });

  it('maps generic YtDlpError to a safe generic message (no stderr leak)', () => {
    const stderr = 'ERROR: /Users/me/secret/path/foo.mp4: Permission denied';
    const msg = friendlyErrorMessage(new YtDlpError('boom', stderr));
    expect(msg).toBe('Download failed. The site may be unsupported or the URL may be invalid.');
    expect(msg).not.toContain('Permission');
    expect(msg).not.toContain('/Users/');
  });

  it('maps YtDlpPasswordRequiredError to a password-specific hint', () => {
    // The full Zoom password modal lands in PR 7. Until then, the row's
    // error block at least tells the user *why* it failed instead of
    // blaming yt-dlp or the URL.
    expect(friendlyErrorMessage(new YtDlpPasswordRequiredError())).toBe(
      'This recording requires a password.',
    );
  });

  it('maps NodeJS.ErrnoException codes to safe strings without leaking paths', () => {
    const enospc = Object.assign(
      new Error("ENOSPC: no space left on device, rename '/Users/me/Downloads/Pluck/foo.mp4'"),
      { code: 'ENOSPC' },
    );
    expect(friendlyErrorMessage(enospc)).toBe('No space left on the destination disk.');

    const eacces = Object.assign(new Error("EACCES: permission denied, mkdir '/locked'"), {
      code: 'EACCES',
    });
    expect(friendlyErrorMessage(eacces)).toBe('Permission denied when saving the download.');

    const eperm = Object.assign(new Error("EPERM: operation not permitted, rename '/x'"), {
      code: 'EPERM',
    });
    expect(friendlyErrorMessage(eperm)).toBe('Permission denied when saving the download.');

    const erofs = Object.assign(new Error("EROFS: read-only file system, rename '/x'"), {
      code: 'EROFS',
    });
    expect(friendlyErrorMessage(erofs)).toBe('The destination is read-only.');

    const enoent = Object.assign(new Error("ENOENT: no such file or directory, rename '/x'"), {
      code: 'ENOENT',
    });
    expect(friendlyErrorMessage(enoent)).toBe('The destination folder no longer exists.');
  });

  it('maps unknown errno codes to a generic save error (no path leak)', () => {
    const e = Object.assign(new Error("EWHATEVER: surprise, rename '/Users/me/private.mp4'"), {
      code: 'EWHATEVER',
    });
    const msg = friendlyErrorMessage(e);
    expect(msg).toBe('Could not save the download.');
    expect(msg).not.toContain('/Users/');
    expect(msg).not.toContain('EWHATEVER');
  });

  it('falls back to a generic message for non-Error throws', () => {
    expect(friendlyErrorMessage('a string was thrown')).toBe('Download failed.');
    expect(friendlyErrorMessage(null)).toBe('Download failed.');
    expect(friendlyErrorMessage(undefined)).toBe('Download failed.');
    expect(friendlyErrorMessage(42)).toBe('Download failed.');
    expect(friendlyErrorMessage({ message: 'plain object' })).toBe('Download failed.');
  });
});

// ---- queue integration --------------------------------------------------

/** Controllable fake runner: each call hangs on a promise the test can
 * resolve/reject on demand. No real processes, no real fs writes — the
 * queue still calls createTempFolder + mkdir + moveFile, so we point those
 * at scratch dirs. */
type FakeRun = {
  opts: RunDownloadOptions;
  resolve: (result: RunDownloadResult) => void;
  reject: (err: Error) => void;
};

let fixtureDir: string;
let tempBaseDir: string;
let outputDir: string;
let idCounter = 0;
let fakeRuns: FakeRun[];

beforeEach(async () => {
  idCounter = 0;
  fakeRuns = [];
  fixtureDir = await fs.mkdtemp(join(tmpdir(), 'pluck-queue-test-'));
  tempBaseDir = join(fixtureDir, 'cache');
  outputDir = join(fixtureDir, 'out');
});

afterEach(async () => {
  // maxRetries handles the race where the queue's runOne `finally` is
  // still removing its per-id temp subdir when the test ends — we'd
  // otherwise see ENOTEMPTY on the parent rm.
  await fs.rm(fixtureDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const buildQueueDeps = (onUpdate: (d: Download) => void) => {
  const runnerDeps: RunnerDeps = { ytDlpPath: '/usr/bin/true', ffmpegPath: '/usr/bin/true' };
  const fakeMeta: VideoMetadata = { id: 'x', title: 'Fake', extractor: 'youtube' };
  const metadataCache: MetadataCache = {
    get: () => Promise.resolve(fakeMeta),
    prefetch: () => {},
    size: () => 0,
  };
  // Capture each call so tests can resolve/reject it on demand. Honors the
  // AbortSignal — abort() rejects with YtDlpCancelledError, matching the
  // real runner's behaviour.
  const runDownload = (opts: RunDownloadOptions): Promise<RunDownloadResult> =>
    new Promise<RunDownloadResult>((resolve, reject) => {
      const entry: FakeRun = { opts, resolve, reject };
      fakeRuns.push(entry);
      opts.cancelSignal?.addEventListener('abort', () => reject(new YtDlpCancelledError()), {
        once: true,
      });
    });
  return {
    defaultOutputFolder: outputDir,
    tempBaseDir,
    runnerDeps,
    runDownload,
    metadataCache,
    generateId: (): string => `id-${++idCounter}`,
    onUpdate,
  };
};

const makeRequest = (url = 'https://example.com/x'): DownloadRequest => ({ url, format: 'best' });

/** Wait until `predicate` is true or `timeoutMs` elapses. Polls every 10 ms. */
const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('DownloadQueue', () => {
  it('enqueue returns an id and the first emit is the queued snapshot', () => {
    const updates: Download[] = [];
    const queue = createDownloadQueue(buildQueueDeps((d) => updates.push(d)));

    const id = queue.enqueue(makeRequest());

    expect(id).toBe('id-1');
    expect(updates[0]?.id).toBe(id);
    expect(updates[0]?.status).toBe('queued');
    queue.cancel(id);
  });

  it('promotes up to 3 concurrent; a 4th stays queued', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const ids = [
      queue.enqueue(makeRequest('https://example.com/1')),
      queue.enqueue(makeRequest('https://example.com/2')),
      queue.enqueue(makeRequest('https://example.com/3')),
      queue.enqueue(makeRequest('https://example.com/4')),
    ];

    await waitFor(() => fakeRuns.length === 3);

    const live = queue.getAll();
    expect(live.filter((d) => d.status === 'downloading')).toHaveLength(3);
    expect(live.find((d) => d.id === ids[3])?.status).toBe('queued');
  });

  it('promotes the next queued row when an active one finishes', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const ids = [
      queue.enqueue(makeRequest('https://example.com/1')),
      queue.enqueue(makeRequest('https://example.com/2')),
      queue.enqueue(makeRequest('https://example.com/3')),
      queue.enqueue(makeRequest('https://example.com/4')),
    ];

    await waitFor(() => fakeRuns.length === 3);

    // Resolve the first active run with a fake file path; queue's finally
    // should free the slot and start id 4.
    const firstRun = fakeRuns[0];
    if (!firstRun) {
      throw new Error('expected first run to be captured');
    }
    const fakeFile = join(firstRun.opts.tempFolder, 'fake.mp4');
    await fs.writeFile(fakeFile, 'x');
    firstRun.resolve({ filePath: fakeFile });

    await waitFor(() => fakeRuns.length === 4, 3000);
    expect(queue.getAll().find((d) => d.id === ids[3])?.status).toBe('downloading');
  });

  it('cancel on a queued row flips to cancelled without spawning a process', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const activeIds = [
      queue.enqueue(makeRequest('https://example.com/1')),
      queue.enqueue(makeRequest('https://example.com/2')),
      queue.enqueue(makeRequest('https://example.com/3')),
    ];
    const queuedId = queue.enqueue(makeRequest('https://example.com/4'));

    await waitFor(() => fakeRuns.length === 3);

    const runsBefore = fakeRuns.length;
    queue.cancel(queuedId);

    expect(queue.getAll().find((d) => d.id === queuedId)?.status).toBe('cancelled');
    expect(fakeRuns.length).toBe(runsBefore); // No new spawn.

    for (const id of activeIds) {
      queue.cancel(id);
    }
  });

  it('cancel on an active row emits canceling synchronously then cancelled', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);

    queue.cancel(id);
    // Optimistic: status flips before the runner has finished tearing
    // down the yt-dlp child. Speed/ETA cleared so the row reads as
    // "stopping" rather than "still going".
    expect(queue.getAll().find((d) => d.id === id)?.status).toBe('canceling');
    expect(queue.getAll().find((d) => d.id === id)?.speed).toBeUndefined();

    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'cancelled');
  });

  it('double-cancel on an active row only aborts once (idempotent)', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);

    const abortSpy = vi.fn();
    fakeRuns[0]?.opts.cancelSignal?.addEventListener('abort', abortSpy);

    queue.cancel(id);
    queue.cancel(id); // Second click during the canceling window.

    expect(queue.getAll().find((d) => d.id === id)?.status).toBe('canceling');
    // Only one abort fired — the second cancel saw status='canceling'
    // and bailed out of the guard.
    expect(abortSpy).toHaveBeenCalledOnce();
  });

  it('cancel on an unknown id is a no-op (does not throw)', () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    expect(() => queue.cancel('does-not-exist')).not.toThrow();
  });

  it('cancel on a terminal row is a no-op (idempotent)', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const activeIds = [
      queue.enqueue(makeRequest('https://example.com/1')),
      queue.enqueue(makeRequest('https://example.com/2')),
      queue.enqueue(makeRequest('https://example.com/3')),
    ];
    const queuedId = queue.enqueue(makeRequest('https://example.com/4'));

    queue.cancel(queuedId);
    queue.cancel(queuedId); // Second cancel — must not re-emit, must not throw.

    expect(queue.getAll().find((d) => d.id === queuedId)?.status).toBe('cancelled');

    for (const id of activeIds) {
      queue.cancel(id);
    }
  });

  it('rehydrate seeds state and does NOT start any downloads', () => {
    const onUpdate = vi.fn();
    const queue = createDownloadQueue(buildQueueDeps(onUpdate));

    queue.rehydrate([
      {
        id: 'past-1',
        url: 'https://example.com/a',
        format: 'best',
        outputFolder: outputDir,
        status: 'completed',
        progress: 100,
        createdAt: 1,
      },
      {
        id: 'past-2',
        url: 'https://example.com/b',
        format: 'best',
        outputFolder: outputDir,
        status: 'failed',
        progress: 0,
        createdAt: 2,
        error: 'something broke',
      },
    ]);

    expect(queue.getAll().map((d) => d.id)).toEqual(['past-1', 'past-2']);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(fakeRuns).toHaveLength(0);
  });

  it('fires onTerminalChange when a queued row is cancelled', () => {
    const onTerminalChange = vi.fn();
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      onTerminalChange,
    });
    const activeIds = [
      queue.enqueue(makeRequest('https://example.com/1')),
      queue.enqueue(makeRequest('https://example.com/2')),
      queue.enqueue(makeRequest('https://example.com/3')),
    ];
    const queuedId = queue.enqueue(makeRequest('https://example.com/4'));

    queue.cancel(queuedId);
    expect(onTerminalChange).toHaveBeenCalled();
    const lastCall = onTerminalChange.mock.calls.at(-1);
    const snapshot = lastCall?.[0] as Download[];
    expect(snapshot.find((d) => d.id === queuedId)?.status).toBe('cancelled');

    for (const id of activeIds) {
      queue.cancel(id);
    }
  });

  it('failed run emits status=failed with a friendly error message', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);

    fakeRuns[0]?.reject(new YtDlpError('something broke'));

    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'failed');
    const row = queue.getAll().find((d) => d.id === id);
    expect(row?.error).toBe(
      'Download failed. The site may be unsupported or the URL may be invalid.',
    );
  });
});
