import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempFolder, moveFile, removeTempFolder, resolveAvailablePath } from './staging';

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(join(tmpdir(), 'pluck-staging-test-'));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('createTempFolder', () => {
  it('creates <base>/pluck/<id>/ and returns its path', async () => {
    const dir = await createTempFolder(workspace, 'youtube-abc-20260516-204530-x7n4ab');
    expect(dir).toBe(join(workspace, 'pluck', 'youtube-abc-20260516-204530-x7n4ab'));
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('is idempotent (running twice succeeds)', async () => {
    const a = await createTempFolder(workspace, 'same-id');
    const b = await createTempFolder(workspace, 'same-id');
    expect(a).toBe(b);
  });
});

describe('removeTempFolder', () => {
  it('removes a populated directory recursively', async () => {
    const dir = await createTempFolder(workspace, 'doomed');
    await fs.writeFile(join(dir, 'fragment.part'), 'data');
    await fs.writeFile(join(dir, 'merged.mp4'), 'video bytes');
    await removeTempFolder(dir);
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('is a no-op when the directory does not exist (safe in finally)', async () => {
    await expect(removeTempFolder(join(workspace, 'never-was'))).resolves.toBeUndefined();
  });
});

describe('resolveAvailablePath', () => {
  it('returns the requested path unchanged when nothing collides', async () => {
    const path = await resolveAvailablePath(workspace, 'Me at the zoo.mp4');
    expect(path).toBe(join(workspace, 'Me at the zoo.mp4'));
  });

  it('appends " (2)" before the extension on first collision', async () => {
    await fs.writeFile(join(workspace, 'Me at the zoo.mp4'), 'existing');
    const path = await resolveAvailablePath(workspace, 'Me at the zoo.mp4');
    expect(path).toBe(join(workspace, 'Me at the zoo (2).mp4'));
  });

  it('keeps incrementing for multiple collisions', async () => {
    await fs.writeFile(join(workspace, 'foo.mp3'), '');
    await fs.writeFile(join(workspace, 'foo (2).mp3'), '');
    await fs.writeFile(join(workspace, 'foo (3).mp3'), '');
    const path = await resolveAvailablePath(workspace, 'foo.mp3');
    expect(path).toBe(join(workspace, 'foo (4).mp3'));
  });

  it('handles filenames with no extension', async () => {
    await fs.writeFile(join(workspace, 'README'), '');
    const path = await resolveAvailablePath(workspace, 'README');
    expect(path).toBe(join(workspace, 'README (2)'));
  });

  it('handles filenames with multiple dots — only the last is the extension', async () => {
    await fs.writeFile(join(workspace, 'archive.tar.gz'), '');
    const path = await resolveAvailablePath(workspace, 'archive.tar.gz');
    expect(path).toBe(join(workspace, 'archive.tar (2).gz'));
  });
});

describe('moveFile', () => {
  it('renames within the same volume (happy path)', async () => {
    const src = join(workspace, 'src.bin');
    const dst = join(workspace, 'subdir', 'dst.bin');
    await fs.writeFile(src, 'payload');
    await fs.mkdir(join(workspace, 'subdir'));

    await moveFile(src, dst);

    expect(await fs.readFile(dst, 'utf-8')).toBe('payload');
    await expect(fs.access(src)).rejects.toThrow();
  });

  it('falls back to copyFile + rm when rename throws EXDEV (cross-volume)', async () => {
    const src = join(workspace, 'cross.bin');
    const dst = join(workspace, 'cross-dst.bin');
    await fs.writeFile(src, 'cross-volume payload');

    const exdev = Object.assign(new Error('cross-device link not permitted'), {
      code: 'EXDEV',
    });
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(exdev);

    await moveFile(src, dst);

    expect(renameSpy).toHaveBeenCalledOnce();
    expect(await fs.readFile(dst, 'utf-8')).toBe('cross-volume payload');
    await expect(fs.access(src)).rejects.toThrow();
  });

  it('propagates non-EXDEV errors (e.g. EACCES) instead of swallowing them', async () => {
    const src = join(workspace, 'fail.bin');
    const dst = join(workspace, 'fail-dst.bin');
    await fs.writeFile(src, 'data');

    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(eacces);

    await expect(moveFile(src, dst)).rejects.toMatchObject({ code: 'EACCES' });
    // The src should still be there since neither rename nor the EXDEV
    // fallback ran to completion.
    expect(await fs.readFile(src, 'utf-8')).toBe('data');
  });

  it('still considers the move successful when the post-EXDEV rm fails', async () => {
    // Edge case: cross-volume case where the temp gets unmounted between
    // copyFile completing and us trying to unlink the source. The bytes
    // are at the destination — that's what matters — so we shouldn't
    // surface a failure to the user. The leftover src will be reaped by
    // the caller's removeTempFolder() in its `finally`.
    const src = join(workspace, 'race.bin');
    const dst = join(workspace, 'race-dst.bin');
    await fs.writeFile(src, 'survives');

    const exdev = Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(exdev);
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(
      Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }),
    );

    await expect(moveFile(src, dst)).resolves.toBeUndefined();
    expect(await fs.readFile(dst, 'utf-8')).toBe('survives');
  });
});
