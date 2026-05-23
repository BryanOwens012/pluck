import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATIC_FORMAT_CHOICES } from '../../shared/types';
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
          ytDlpFormatArgs: [
            '-f',
            'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]/b[ext=mp4]/b',
            '-S',
            'res,vcodec:h264,fps',
          ],
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
          ytDlpFormatArgs: [
            '-f',
            'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]/b[ext=mp4]/b',
            '-S',
            'res,vcodec:h264,fps',
          ],
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
          ytDlpFormatArgs: [
            '-f',
            'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]/b[ext=mp4]/b',
            '-S',
            'res,vcodec:h264,fps',
          ],
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
          ytDlpFormatArgs: [
            '-f',
            'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]/b[ext=mp4]/b',
            '-S',
            'res,vcodec:h264,fps',
          ],
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
          ytDlpFormatArgs: [
            '-f',
            'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]/b[ext=mp4]/b',
            '-S',
            'res,vcodec:h264,fps',
          ],
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
          ytDlpFormatArgs: [
            '-f',
            'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]/b[ext=mp4]/b',
            '-S',
            'res,vcodec:h264,fps',
          ],
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

describe('runDownload format-flags (mp4-preferring presets)', () => {
  // Every video preset must (a) prefer mp4 container so the file plays
  // in QuickTime/iMessage, and (b) sort candidate streams by
  // res,vcodec:h264,fps — h264 preference is weighted ahead of fps so
  // a 1080p30 h264 stream wins over a 1080p60 av1-in-mp4 stream that
  // QuickTime can't decode well on M1/M2 Macs. The [vcodec!*=av01]
  // filter is also belt-and-suspenders against av1-in-mp4.

  const runAndReadArgv = async (preset: keyof typeof STATIC_FORMAT_CHOICES): Promise<string> => {
    const workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-format-test-'));
    const fakePath = await argvRecorder(workspace);
    try {
      await runDownload(
        {
          url: 'https://example.com/x',
          ytDlpFormatArgs: STATIC_FORMAT_CHOICES[preset].ytDlpFormatArgs,
          tempFolder: workspace,
        },
        { ytDlpPath: fakePath, ffmpegPath: '/usr/bin/true' },
      ).catch(() => {});
      return await fs.readFile(join(workspace, '.argv'), 'utf-8');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  };

  it('best: -f filters to mp4 video + m4a audio, falls back to single mp4', async () => {
    const argv = await runAndReadArgv('best');
    expect(argv).toContain(
      'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]/b[ext=mp4]/b',
    );
    expect(argv).toMatch(/-S res,vcodec:h264,fps/);
  });

  it('1080p: caps height inside the mp4 filter', async () => {
    const argv = await runAndReadArgv('1080p');
    expect(argv).toContain(
      'bv*[ext=mp4][vcodec!*=av01][height<=1080]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=1080]',
    );
    expect(argv).toMatch(/-S res,vcodec:h264,fps/);
  });

  it('720p: caps height inside the mp4 filter', async () => {
    const argv = await runAndReadArgv('720p');
    expect(argv).toContain(
      'bv*[ext=mp4][vcodec!*=av01][height<=720]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01][height<=720]',
    );
    expect(argv).toMatch(/-S res,vcodec:h264,fps/);
  });

  it('audio_mp3: extraction path, no -S sort (container-agnostic by design)', async () => {
    const argv = await runAndReadArgv('audio_mp3');
    expect(argv).toContain('-x');
    expect(argv).toContain('--audio-format mp3');
    expect(argv).toContain('--audio-quality 0');
    // -S is for video container/codec sorting; mp3 extraction
    // re-encodes regardless of source container, so -S would be wasted.
    expect(argv).not.toMatch(/-S res,vcodec:h264,fps/);
  });

  it('never emits a bare `-f bv*+ba/b` selector (must specify mp4 container)', async () => {
    // A bare selector lets YouTube serve vp9/webm by default; we always
    // pin mp4 so the file plays in QuickTime / iMessage / iMovie.
    const argv = await runAndReadArgv('best');
    expect(argv).not.toMatch(/-f bv\*\+ba\/b\s/);
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
          ytDlpFormatArgs: [
            '-f',
            'bv*[ext=mp4][vcodec!*=av01]+ba[ext=m4a]/b[ext=mp4][vcodec!*=av01]/b[ext=mp4]/b',
            '-S',
            'res,vcodec:h264,fps',
          ],
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
