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

describe('runDownload --cookies-from-browser pass-through', () => {
  /** Fake yt-dlp that records argv to a file inside the tempFolder then
   * exits 1. We only care about what args were passed — the resulting
   * YtDlpError rejection is expected and ignored. */
  const argvRecorder = async (dir: string): Promise<string> => {
    const path = join(dir, 'argv-recorder');
    await fs.writeFile(
      path,
      '#!/bin/sh\nfor a in "$@"; do echo "$a" >> "$1/.argv"; done; exit 1\n',
    );
    // Note: the script's first positional arg ($1) is the tempFolder
    // we pass via `--paths home:<tempFolder>` — but $1 here is the
    // first ALL-arg from yt-dlp's invocation, which is `--newline`.
    // We use a fixed env var instead. Rewriting:
    await fs.writeFile(path, `#!/bin/sh\necho "$@" > "${dir}/.argv"\nexit 1\n`);
    await fs.chmod(path, 0o755);
    return path;
  };

  it('passes --cookies-from-browser when cookiesFromBrowser is set', async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-cookies-test-'));
    const fakePath = await argvRecorder(workspace);
    try {
      await runDownload(
        {
          url: 'https://example.com/x',
          format: 'best',
          tempFolder: workspace,
          cookiesFromBrowser: 'chrome',
        },
        { ytDlpPath: fakePath, ffmpegPath: '/usr/bin/true' },
      ).catch(() => {
        // Expected — fake exits 1.
      });
      const argv = await fs.readFile(join(workspace, '.argv'), 'utf-8');
      expect(argv).toContain('--cookies-from-browser');
      expect(argv).toContain('chrome');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('omits --cookies-from-browser when unset', async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-cookies-test-'));
    const fakePath = await argvRecorder(workspace);
    try {
      await runDownload(
        {
          url: 'https://example.com/x',
          format: 'best',
          tempFolder: workspace,
        },
        { ytDlpPath: fakePath, ffmpegPath: '/usr/bin/true' },
      ).catch(() => {
        // Expected — fake exits 1.
      });
      const argv = await fs.readFile(join(workspace, '.argv'), 'utf-8');
      expect(argv).not.toContain('--cookies-from-browser');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
