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

/** Fake yt-dlp that writes its argv (space-joined) to `<dir>/.argv`
 * and exits 1. Tests read the file to assert what args were passed;
 * the YtDlpError rejection is expected and ignored. Shared by every
 * argv-assertion test below. */
const argvRecorder = async (dir: string): Promise<string> => {
  const path = join(dir, 'argv-recorder');
  await fs.writeFile(path, `#!/bin/sh\necho "$@" > "${dir}/.argv"\nexit 1\n`);
  await fs.chmod(path, 0o755);
  return path;
};

describe('runDownload --cookies-from-browser pass-through', () => {
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

describe('runDownload -N (concurrent fragments) pass-through', () => {
  it('passes -N <value> when concurrentFragments is set', async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-nfragments-test-'));
    const fakePath = await argvRecorder(workspace);
    try {
      await runDownload(
        {
          url: 'https://example.com/x',
          format: 'best',
          tempFolder: workspace,
          concurrentFragments: 8,
        },
        { ytDlpPath: fakePath, ffmpegPath: '/usr/bin/true' },
      ).catch(() => {});
      const argv = await fs.readFile(join(workspace, '.argv'), 'utf-8');
      // -N 8 appears as adjacent tokens in the argv echo.
      expect(argv).toMatch(/-N 8/);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('falls back to the runner default (14) when unset', async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-nfragments-test-'));
    const fakePath = await argvRecorder(workspace);
    try {
      await runDownload(
        {
          url: 'https://example.com/x',
          format: 'best',
          tempFolder: workspace,
        },
        { ytDlpPath: fakePath, ffmpegPath: '/usr/bin/true' },
      ).catch(() => {});
      const argv = await fs.readFile(join(workspace, '.argv'), 'utf-8');
      expect(argv).toMatch(/-N 14/);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('runDownload onRawLine (debug log tap)', () => {
  /** Fake yt-dlp that prints a few lines to stdout AND stderr then
   * exits 1. The order matters for the test: we want to confirm BOTH
   * streams are forwarded through onRawLine. */
  const chatteringRunner = async (dir: string): Promise<string> => {
    const path = join(dir, 'chattering-yt-dlp');
    await fs.writeFile(
      path,
      `#!/bin/sh
echo "stdout-line-1"
echo "stderr-line-1" >&2
echo "stdout-line-2"
echo "stderr-line-2" >&2
exit 1
`,
    );
    await fs.chmod(path, 0o755);
    return path;
  };

  it('invokes onRawLine for every stdout AND stderr line', async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-rawline-test-'));
    const fakePath = await chatteringRunner(workspace);
    const lines: string[] = [];
    try {
      await runDownload(
        {
          url: 'https://example.com/x',
          format: 'best',
          tempFolder: workspace,
          onRawLine: (line) => lines.push(line),
        },
        { ytDlpPath: fakePath, ffmpegPath: '/usr/bin/true' },
      ).catch(() => {
        // Expected — fake exits 1.
      });
      // Order between stdout vs stderr lines isn't deterministic
      // (separate readline streams) — just assert all four landed.
      expect(lines).toContain('stdout-line-1');
      expect(lines).toContain('stdout-line-2');
      expect(lines).toContain('stderr-line-1');
      expect(lines).toContain('stderr-line-2');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
