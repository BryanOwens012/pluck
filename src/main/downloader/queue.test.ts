import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Download, type DownloadRequest, STATIC_FORMAT_CHOICES } from '../../shared/types';
import type { MetadataCache } from '../metadata-cache';
import type {
  RunDownloadOptions,
  RunDownloadResult,
  RunnerDeps,
  VideoMetadata,
} from '../ytdlp/types';
import {
  YtDlpCancelledError,
  YtDlpCookieAccessDeniedError,
  YtDlpError,
  YtDlpPasswordRequiredError,
} from '../ytdlp/types';
import {
  createDownloadQueue,
  friendlyCookieDeniedMessage,
  friendlyErrorMessage,
  padToMinDuration,
} from './queue';

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
    // This is the fallback message — the queue routes password-required
    // errors through 'needs_password' status instead so the password
    // prompt modal opens. The friendly string only surfaces if some
    // non-queue caller bypasses that path.
    expect(friendlyErrorMessage(new YtDlpPasswordRequiredError())).toBe(
      'This recording requires a password.',
    );
  });

  it('maps YtDlpCookieAccessDeniedError to a per-browser actionable message', () => {
    // Chromium-family → Keychain hint.
    const chromeMsg = friendlyErrorMessage(new YtDlpCookieAccessDeniedError('chrome'));
    expect(chromeMsg).toContain('chrome');
    expect(chromeMsg).toMatch(/Keychain/i);
    expect(chromeMsg).toContain('Settings');

    // Safari → Full Disk Access hint (different system pref path).
    const safariMsg = friendlyErrorMessage(new YtDlpCookieAccessDeniedError('safari'));
    expect(safariMsg).toMatch(/Full Disk Access/i);
    expect(safariMsg).toContain('Safari');
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
  const fakeMeta: VideoMetadata = { id: 'x', title: 'Fake', extractor: 'youtube', formats: [] };
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
    getDefaultOutputFolder: (): string => outputDir,
    getCookiesFromBrowser: (): string | undefined => undefined,
    getConcurrentFragments: (): number => 14,
    getYtDlpCommandOverride: (): string | undefined => undefined,
    getMaxConcurrentDownloads: (): number => 3,
    getDebugMode: (): boolean => false,
    tempBaseDir,
    runnerDeps,
    runDownload,
    metadataCache,
    generateId: (): string => `id-${++idCounter}`,
    onUpdate,
  };
};

const makeRequest = (url = 'https://example.com/x'): DownloadRequest => ({
  url,
  format: STATIC_FORMAT_CHOICES.best,
});

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

  it('respects a live getMaxConcurrentDownloads override (cap=5 promotes 5)', async () => {
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      getMaxConcurrentDownloads: () => 5,
    });
    const ids = Array.from({ length: 6 }, (_, i) =>
      queue.enqueue(makeRequest(`https://example.com/${i}`)),
    );

    await waitFor(() => fakeRuns.length === 5);
    const live = queue.getAll();
    expect(live.filter((d) => d.status === 'downloading')).toHaveLength(5);
    expect(live.find((d) => d.id === ids[5])?.status).toBe('queued');
  });

  it('respects a cap=1 (serial-downloads mode)', async () => {
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      getMaxConcurrentDownloads: () => 1,
    });
    queue.enqueue(makeRequest('https://example.com/1'));
    queue.enqueue(makeRequest('https://example.com/2'));

    await waitFor(() => fakeRuns.length === 1);
    // Only one running; the second should stay queued.
    const live = queue.getAll();
    expect(live.filter((d) => d.status === 'downloading')).toHaveLength(1);
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

  it('clearAll drops every row and persists an empty snapshot', async () => {
    const persisted: Download[][] = [];
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      onPersistChange: (snapshot) => persisted.push(snapshot),
    });
    queue.enqueue(makeRequest('https://example.com/1'));
    queue.enqueue(makeRequest('https://example.com/2'));
    queue.enqueue(makeRequest('https://example.com/3'));
    queue.enqueue(makeRequest('https://example.com/4'));

    await waitFor(() => fakeRuns.length === 3);
    expect(queue.getAll()).toHaveLength(4);

    queue.clearAll();

    expect(queue.getAll()).toHaveLength(0);
    // Last persisted snapshot must be the empty wipe — disk truth.
    expect(persisted.at(-1)).toEqual([]);
  });

  it('clearAll preserves the concurrency cap for the next batch', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    // Enqueue 4 against the default cap of 3, then clearAll. The 3
    // in-flight runners' finally blocks must wind activeCount back
    // down to 0 — so a fresh batch can promote up to the cap again.
    // If clearAll resets activeCount to 0 prematurely, the orphaned
    // finally blocks will push it negative and the next enqueue will
    // over-promote.
    for (let i = 0; i < 4; i++) {
      queue.enqueue(makeRequest(`https://example.com/${i}`));
    }
    await waitFor(() => fakeRuns.length === 3);
    const orphanedRuns = [...fakeRuns];

    queue.clearAll();
    // Drain the aborted runs so the orphaned finally blocks
    // decrement activeCount.
    const { YtDlpCancelledError } = await import('../ytdlp/types');
    for (const run of orphanedRuns) {
      run.reject(new YtDlpCancelledError());
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Fresh batch: enqueue 3 more. All three should promote.
    fakeRuns.length = 0;
    for (let i = 0; i < 3; i++) {
      queue.enqueue(makeRequest(`https://example.com/new-${i}`));
    }
    await waitFor(() => fakeRuns.length === 3);

    expect(queue.getAll().filter((d) => d.status === 'downloading')).toHaveLength(3);
  });

  it('clearAll aborts in-flight runners and their post-abort emit is a no-op', async () => {
    const updates: Download[] = [];
    const queue = createDownloadQueue(buildQueueDeps((d) => updates.push(d)));
    queue.enqueue(makeRequest('https://example.com/1'));
    await waitFor(() => fakeRuns.length === 1);

    queue.clearAll();
    const updatesBeforeReject = updates.length;

    // Reject the orphaned run as if abort triggered YtDlpCancelledError.
    // The runner's terminal emit() must not resurrect the wiped row.
    const run = fakeRuns[0];
    if (!run) {
      throw new Error('expected fake run');
    }
    run.reject(new (await import('../ytdlp/types')).YtDlpCancelledError());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(queue.getAll()).toHaveLength(0);
    // No new updates from the orphaned run's terminal emit — state
    // lookup misses, emit short-circuits.
    expect(updates.length).toBe(updatesBeforeReject);
  });

  it('emits no debug log events when getDebugMode returns false', async () => {
    const onDebugLog = vi.fn();
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      onDebugLog,
    });
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);
    // Synthesize a progress event so the queue's emit-debug guard
    // fires through the throttled progress path too.
    fakeRuns[0]?.opts.onProgress?.({ status: 'downloading', percent: 50 });

    // Debug mode off → onDebugLog never called regardless of how many
    // phase boundaries we cross.
    expect(onDebugLog).not.toHaveBeenCalled();

    queue.cancel(id);
  });

  it('emits lifecycle phase events when getDebugMode returns true', async () => {
    const onDebugLog = vi.fn();
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      getDebugMode: () => true,
      onDebugLog,
    });
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);
    // Resolve the run successfully so we walk all phase boundaries.
    const fakeFile = join(fakeRuns[0]?.opts.tempFolder ?? '', 'fake.mp4');
    await fs.writeFile(fakeFile, 'x');
    fakeRuns[0]?.resolve({ filePath: fakeFile });

    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'completed', 3000);

    const phases = onDebugLog.mock.calls.map((c) => (c[0] as { phase: string }).phase);
    expect(phases).toContain('metadata:start');
    expect(phases).toContain('metadata:done');
    expect(phases).toContain('download:start');
    expect(phases).toContain('download:done');
    expect(phases).toContain('move:start');
    expect(phases).toContain('move:done');
    expect(phases).toContain('cleanup:done');
  });

  it('reads getDefaultOutputFolder on every enqueue (live-read semantics)', () => {
    // Folder change between two enqueues should land each row in the
    // right folder — first uses A, second uses B. In-flight rows are
    // unaffected because Download.outputFolder is snapshotted at enqueue.
    let folder = '/tmp/folder-a';
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      getDefaultOutputFolder: () => folder,
    });
    const idA = queue.enqueue(makeRequest('https://example.com/a'));
    folder = '/tmp/folder-b';
    const idB = queue.enqueue(makeRequest('https://example.com/b'));

    expect(queue.getAll().find((d) => d.id === idA)?.outputFolder).toBe('/tmp/folder-a');
    expect(queue.getAll().find((d) => d.id === idB)?.outputFolder).toBe('/tmp/folder-b');

    queue.cancel(idA);
    queue.cancel(idB);
  });

  it('rehydrate seeds state and does NOT start any downloads', () => {
    const onUpdate = vi.fn();
    const queue = createDownloadQueue(buildQueueDeps(onUpdate));

    queue.rehydrate([
      {
        id: 'past-1',
        url: 'https://example.com/a',
        format: STATIC_FORMAT_CHOICES.best,
        outputFolder: outputDir,
        status: 'completed',
        progress: 100,
        createdAt: 1,
      },
      {
        id: 'past-2',
        url: 'https://example.com/b',
        format: STATIC_FORMAT_CHOICES.best,
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

  it('fires onPersistChange on enqueue and on every status transition', () => {
    const onPersistChange = vi.fn();
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      onPersistChange,
    });
    const id = queue.enqueue(makeRequest());

    // enqueue → 'queued' (1) → 'downloading' (2). Multiple emits per
    // status are fine; what matters is that every transition saves.
    expect(onPersistChange.mock.calls.length).toBeGreaterThanOrEqual(2);

    queue.cancel(id);
    // 'downloading' → 'canceling' is also a transition → save fires.
    const lastCall = onPersistChange.mock.calls.at(-1);
    const snapshot = lastCall?.[0] as Download[];
    expect(snapshot.find((d) => d.id === id)?.status).toBe('canceling');
  });

  it('does NOT fire onPersistChange on in-status progress patches', async () => {
    const onPersistChange = vi.fn();
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      onPersistChange,
    });
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);
    const callsAfterEnqueue = onPersistChange.mock.calls.length;

    // Synthesize a few progress events at the same 'downloading' status.
    fakeRuns[0]?.opts.onProgress?.({ status: 'downloading', percent: 10 });
    fakeRuns[0]?.opts.onProgress?.({ status: 'downloading', percent: 20 });
    fakeRuns[0]?.opts.onProgress?.({ status: 'downloading', percent: 30 });

    expect(onPersistChange.mock.calls.length).toBe(callsAfterEnqueue);

    queue.cancel(id);
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

  it('cookie-denied run flips to failed with a per-browser actionable message', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);
    fakeRuns[0]?.reject(new YtDlpCookieAccessDeniedError('chrome', 'stderr noise'));

    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'failed');
    const row = queue.getAll().find((d) => d.id === id);
    // Verifies the propagation, not the message wording (that's
    // covered by the friendlyCookieDeniedMessage unit test above).
    expect(row?.error).toBe(friendlyCookieDeniedMessage('chrome'));
  });

  it('password-required run flips to needs_password (not failed)', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);
    fakeRuns[0]?.reject(new YtDlpPasswordRequiredError('zoom: password required'));

    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'needs_password');
    const row = queue.getAll().find((d) => d.id === id);
    expect(row?.error).toBeUndefined(); // not a "failure", per se
    expect(row?.passwordAttempts ?? 0).toBe(0); // first natural prompt
  });

  it('submitPassword re-runs the download with the supplied password', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);
    fakeRuns[0]?.reject(new YtDlpPasswordRequiredError());
    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'needs_password');

    queue.submitPassword(id, 'secret-123');

    await waitFor(() => fakeRuns.length === 2);
    expect(fakeRuns[1]?.opts.videoPassword).toBe('secret-123');
    expect(queue.getAll().find((d) => d.id === id)?.passwordAttempts).toBe(1);

    queue.cancel(id);
  });

  it('flips to failed after MAX_PASSWORD_ATTEMPTS (3) wrong submissions', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    // First natural prompt — no submission yet, no attempt counted.
    await waitFor(() => fakeRuns.length === 1);
    fakeRuns[0]?.reject(new YtDlpPasswordRequiredError());
    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'needs_password');

    for (let i = 1; i <= 3; i += 1) {
      queue.submitPassword(id, `wrong-${i}`);
      await waitFor(() => fakeRuns.length === i + 1);
      fakeRuns[i]?.reject(new YtDlpPasswordRequiredError());
      await waitFor(() => {
        const r = queue.getAll().find((d) => d.id === id);
        return r?.status === 'needs_password' || (i === 3 && r?.status === 'failed');
      });
    }

    const finalRow = queue.getAll().find((d) => d.id === id);
    expect(finalRow?.status).toBe('failed');
    expect(finalRow?.error).toBe('Incorrect password (3 attempts).');
    expect(finalRow?.passwordAttempts).toBe(3);
  });

  it('submitPassword is a no-op for ids not in needs_password', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);
    // Row is in 'downloading'; submitPassword shouldn't queue a re-run.
    const runsBefore = fakeRuns.length;
    queue.submitPassword(id, 'whatever');
    expect(fakeRuns.length).toBe(runsBefore);
    expect(queue.getAll().find((d) => d.id === id)?.status).toBe('downloading');

    queue.cancel(id);
  });

  it('cancel on a needs_password row flips to cancelled (no process to kill)', async () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());

    await waitFor(() => fakeRuns.length === 1);
    fakeRuns[0]?.reject(new YtDlpPasswordRequiredError());
    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'needs_password');

    queue.cancel(id);
    expect(queue.getAll().find((d) => d.id === id)?.status).toBe('cancelled');
  });

  it('enqueue copies playlist fields from the request onto the Download', () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue({
      ...makeRequest('https://example.com/playlist-entry-1'),
      playlistId: 'PLxxx',
      playlistTitle: 'My Series',
      playlistIndex: 3,
      playlistTotal: 47,
    });
    const row = queue.getAll().find((d) => d.id === id);
    expect(row?.playlistId).toBe('PLxxx');
    expect(row?.playlistTitle).toBe('My Series');
    expect(row?.playlistIndex).toBe(3);
    expect(row?.playlistTotal).toBe(47);
    queue.cancel(id);
  });

  it('enqueue leaves playlist fields undefined when the request omits them', () => {
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    const id = queue.enqueue(makeRequest());
    const row = queue.getAll().find((d) => d.id === id);
    expect(row?.playlistId).toBeUndefined();
    expect(row?.playlistTitle).toBeUndefined();
    expect(row?.playlistIndex).toBeUndefined();
    expect(row?.playlistTotal).toBeUndefined();
    queue.cancel(id);
  });

  it('throttles playlist rows: caps -N at 2 and sets --sleep-requests', async () => {
    // A row with playlistId set bypasses the user's concurrentFragments
    // setting and uses the PLAYLIST_ROW_CONCURRENT_FRAGMENTS cap.
    // Single-video downloads keep the user's setting.
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      getConcurrentFragments: () => 14,
    });
    const id = queue.enqueue({
      ...makeRequest('https://example.com/playlist-entry'),
      playlistId: 'PLxxx',
      playlistTitle: 'My Series',
      playlistIndex: 1,
      playlistTotal: 50,
    });
    await waitFor(() => fakeRuns.length === 1);
    expect(fakeRuns[0]?.opts.concurrentFragments).toBe(2);
    expect(fakeRuns[0]?.opts.requestSleepSeconds).toBe(1);
    queue.cancel(id);
  });

  it('non-playlist rows keep the user-configured -N and no sleep', async () => {
    const queue = createDownloadQueue({
      ...buildQueueDeps(() => {}),
      getConcurrentFragments: () => 14,
    });
    const id = queue.enqueue(makeRequest());
    await waitFor(() => fakeRuns.length === 1);
    expect(fakeRuns[0]?.opts.concurrentFragments).toBe(14);
    expect(fakeRuns[0]?.opts.requestSleepSeconds).toBeUndefined();
    queue.cancel(id);
  });

  it('serializes playlist rows even when the global cap allows more concurrency', async () => {
    // Global cap is 3 (default). Three playlist rows enqueued — only
    // ONE should start. The other two sit in 'queued' until the first
    // finishes. Anonymous YouTube rate-limits accumulate across
    // processes, so running playlist rows in parallel re-trips 429s
    // even with the per-row -N + sleep throttles.
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    queue.enqueue({
      ...makeRequest('https://example.com/p1'),
      playlistId: 'PLxxx',
      playlistIndex: 1,
      playlistTotal: 3,
    });
    queue.enqueue({
      ...makeRequest('https://example.com/p2'),
      playlistId: 'PLxxx',
      playlistIndex: 2,
      playlistTotal: 3,
    });
    queue.enqueue({
      ...makeRequest('https://example.com/p3'),
      playlistId: 'PLxxx',
      playlistIndex: 3,
      playlistTotal: 3,
    });

    await waitFor(() => fakeRuns.length === 1);
    // Give the queue a tick to potentially (incorrectly) promote more.
    await new Promise((r) => setTimeout(r, 30));
    expect(fakeRuns.length).toBe(1);
    expect(queue.getAll().filter((d) => d.status === 'downloading')).toHaveLength(1);
    expect(queue.getAll().filter((d) => d.status === 'queued')).toHaveLength(2);

    // Finish the first playlist row; the next should promote.
    const firstRun = fakeRuns[0];
    if (!firstRun) {
      throw new Error('expected first run to be captured');
    }
    const fakeFile = join(firstRun.opts.tempFolder, 'fake.mp4');
    await fs.writeFile(fakeFile, 'x');
    firstRun.resolve({ filePath: fakeFile });
    await waitFor(() => fakeRuns.length === 2);
    expect(fakeRuns.length).toBe(2);
  });

  it('promotes a non-playlist row alongside an active playlist row', async () => {
    // The serial cap is per-playlist-source, not global. A single-video
    // row should be allowed to run in parallel with an active playlist
    // row up to the global cap.
    const queue = createDownloadQueue(buildQueueDeps(() => {}));
    queue.enqueue({
      ...makeRequest('https://example.com/p1'),
      playlistId: 'PLxxx',
      playlistIndex: 1,
      playlistTotal: 2,
    });
    queue.enqueue(makeRequest('https://example.com/single'));

    await waitFor(() => fakeRuns.length === 2);
    expect(queue.getAll().filter((d) => d.status === 'downloading')).toHaveLength(2);
  });

  // ---- filename + per-playlist subfolder (PR 9.6g) ---------------------

  /** Drive a queued row to 'completed' by writing a fake post-merge file
   * into the runner's tempFolder and resolving the first fake run.
   * Returns the final Download record. */
  const driveToCompletion = async (
    queue: ReturnType<typeof createDownloadQueue>,
    id: string,
    fakeBasename = 'fake.mp4',
  ): Promise<Download> => {
    await waitFor(() => fakeRuns.length === 1);
    const run = fakeRuns[0];
    if (!run) {
      throw new Error('expected a fake run to be captured');
    }
    const fakeFile = join(run.opts.tempFolder, fakeBasename);
    await fs.writeFile(fakeFile, 'x');
    run.resolve({ filePath: fakeFile });
    await waitFor(() => queue.getAll().find((d) => d.id === id)?.status === 'completed', 3000);
    const finalRow = queue.getAll().find((d) => d.id === id);
    if (!finalRow) {
      throw new Error('expected the completed row in queue.getAll()');
    }
    return finalRow;
  };

  /** Build queue deps with a custom VideoMetadata returned by the cache.
   * Lets each test pin uploader / uploadDate / title independently of
   * the module-level `fakeMeta`. */
  const buildQueueDepsWithMeta = (meta: VideoMetadata) => {
    const deps = buildQueueDeps(() => {});
    return {
      ...deps,
      metadataCache: {
        get: (): Promise<VideoMetadata> => Promise.resolve(meta),
        prefetch: (): void => {},
        size: (): number => 0,
      },
    };
  };

  it('renames single-video downloads to `<Uploader> - <Title> (YYYY-MM-DD).<ext>` in the output folder', async () => {
    const queue = createDownloadQueue(
      buildQueueDepsWithMeta({
        id: 'vid-1',
        title: 'How Bitcoin Works',
        extractor: 'youtube',
        uploader: 'Coinbase',
        uploadDate: '20251002',
        formats: [],
      }),
    );
    const id = queue.enqueue(makeRequest());
    const row = await driveToCompletion(queue, id);

    expect(row.filePath).toBe(join(outputDir, 'Coinbase - How Bitcoin Works (2025-10-02).mp4'));
  });

  it('routes playlist rows into a per-playlist subfolder named after the playlist title', async () => {
    const queue = createDownloadQueue(
      buildQueueDepsWithMeta({
        id: 'vid-1',
        title: 'Episode One',
        extractor: 'youtube',
        uploader: 'Coinbase',
        uploadDate: '20250112',
        formats: [],
      }),
    );
    const id = queue.enqueue({
      ...makeRequest(),
      playlistId: 'PLxxx',
      playlistTitle: 'Coinbase Trading Series',
      playlistIndex: 1,
      playlistTotal: 47,
    });
    const row = await driveToCompletion(queue, id);

    expect(row.filePath).toBe(
      join(outputDir, 'Coinbase Trading Series', '01 Coinbase - Episode One (2025-01-12).mp4'),
    );
  });

  it('uses today as the date when uploadDate is missing (so filenames are never date-less)', async () => {
    const queue = createDownloadQueue(
      buildQueueDepsWithMeta({
        id: 'vid-1',
        title: 'Live Now',
        extractor: 'youtube',
        uploader: 'NewsCo',
        // no uploadDate
        formats: [],
      }),
    );
    const id = queue.enqueue(makeRequest());
    const row = await driveToCompletion(queue, id);

    const filename = row.filePath?.split('/').at(-1) ?? '';
    // Today's date in YYYY-MM-DD: just regex-match the date shape so
    // this test isn't timezone-flaky.
    expect(filename).toMatch(/^NewsCo - Live Now \(\d{4}-\d{2}-\d{2}\)\.mp4$/);
  });

  it('drops the `<Uploader> - ` prefix when the source has no uploader', async () => {
    const queue = createDownloadQueue(
      buildQueueDepsWithMeta({
        id: 'vid-1',
        title: 'Standalone',
        extractor: 'generic',
        // no uploader
        uploadDate: '20251002',
        formats: [],
      }),
    );
    const id = queue.enqueue(makeRequest());
    const row = await driveToCompletion(queue, id);

    expect(row.filePath).toBe(join(outputDir, 'Standalone (2025-10-02).mp4'));
  });

  it('stamps uploader + uploadDate on the Download row from the metadata fetch', async () => {
    const queue = createDownloadQueue(
      buildQueueDepsWithMeta({
        id: 'vid-1',
        title: 'T',
        extractor: 'youtube',
        uploader: 'Channel',
        uploadDate: '20250101',
        formats: [],
      }),
    );
    const id = queue.enqueue(makeRequest());
    const row = await driveToCompletion(queue, id);

    expect(row.uploader).toBe('Channel');
    expect(row.uploadDate).toBe('20250101');
  });
});
