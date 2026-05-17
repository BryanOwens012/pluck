import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDownload } from './runner';
import { YtDlpCancelledError, YtDlpError } from './types';

// Stand-in for the real yt-dlp binary: a shell script that ignores all args
// and sleeps until killed. Lets us drive the runner's cancel path without
// network or a real yt-dlp install.
let fakeYtDlpPath: string;
let fixtureDir: string;

beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(join(tmpdir(), 'pluck-runner-test-'));
  fakeYtDlpPath = join(fixtureDir, 'fake-yt-dlp');
  await fs.writeFile(fakeYtDlpPath, '#!/bin/sh\nsleep 30\n');
  await fs.chmod(fakeYtDlpPath, 0o755);
});

afterAll(async () => {
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

describe('runDownload cancellation', () => {
  it('rejects with YtDlpCancelledError when the cancel signal aborts mid-run', async () => {
    const controller = new AbortController();
    const workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-runner-ws-'));
    try {
      const promise = runDownload(
        {
          url: 'https://example.com/x',
          format: 'best',
          tempFolder: workspace,
          cancelSignal: controller.signal,
        },
        { ytDlpPath: fakeYtDlpPath, ffmpegPath: '/usr/bin/true' },
      );
      // Defer abort a tick so spawn() returns and listeners attach before
      // the signal fires — exercises the addEventListener branch, not the
      // already-aborted branch.
      setTimeout(() => controller.abort(), 25);
      await expect(promise).rejects.toBeInstanceOf(YtDlpCancelledError);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects with YtDlpCancelledError when the signal is already aborted at call time', async () => {
    const controller = new AbortController();
    controller.abort();
    const workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-runner-ws-'));
    try {
      const promise = runDownload(
        {
          url: 'https://example.com/x',
          format: 'best',
          tempFolder: workspace,
          cancelSignal: controller.signal,
        },
        { ytDlpPath: fakeYtDlpPath, ffmpegPath: '/usr/bin/true' },
      );
      await expect(promise).rejects.toBeInstanceOf(YtDlpCancelledError);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('YtDlpCancelledError', () => {
  it('is a YtDlpError subclass with the expected name and message', () => {
    const err = new YtDlpCancelledError();
    expect(err).toBeInstanceOf(YtDlpError);
    expect(err.name).toBe('YtDlpCancelledError');
    expect(err.message).toBe('Download cancelled by user.');
    expect(err.stderr).toBeUndefined();
  });
});
