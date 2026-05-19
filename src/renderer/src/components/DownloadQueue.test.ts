import { describe, expect, it } from 'vitest';
import type { Download, DownloadStatus } from '../../../shared/types';
import { STATIC_FORMAT_CHOICES } from '../../../shared/types';
import { partitionRows } from './download-queue-partition';

const makeRow = (
  id: string,
  status: DownloadStatus,
  opts: { playlistId?: string; createdAt?: number } = {},
): Download => ({
  id,
  url: `https://example.com/${id}`,
  format: STATIC_FORMAT_CHOICES.best,
  outputFolder: '/tmp/out',
  status,
  progress: 0,
  createdAt: opts.createdAt ?? 1000,
  playlistId: opts.playlistId,
});

describe('partitionRows', () => {
  it('puts standalone rows into the correct section by terminal status', () => {
    const { activeItems, historyItems } = partitionRows([
      makeRow('a', 'downloading'),
      makeRow('b', 'completed'),
      makeRow('c', 'queued'),
      makeRow('d', 'failed'),
    ]);

    expect(activeItems.map(itemKey)).toEqual(['row:a', 'row:c']);
    expect(historyItems.map(itemKey)).toEqual(['row:b', 'row:d']);
  });

  it('folds contiguous same-playlistId rows into one group item', () => {
    const { activeItems, historyItems } = partitionRows([
      makeRow('p1', 'downloading', { playlistId: 'PLxxx' }),
      makeRow('p2', 'queued', { playlistId: 'PLxxx' }),
      makeRow('p3', 'queued', { playlistId: 'PLxxx' }),
    ]);

    expect(activeItems).toHaveLength(1);
    expect(historyItems).toHaveLength(0);
    const item = activeItems[0];
    expect(item?.kind).toBe('group');
    if (item?.kind === 'group') {
      expect(item.rows.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    }
  });

  it('routes a playlist group to active when ANY row is non-terminal (mixed group stays together)', () => {
    // The whole playlist (including completed rows) shows in the
    // active section while at least one row is still in motion. The
    // user sees the playlist as one unit instead of split across
    // active + History.
    const { activeItems, historyItems } = partitionRows([
      makeRow('p1', 'completed', { playlistId: 'PLxxx' }),
      makeRow('p2', 'completed', { playlistId: 'PLxxx' }),
      makeRow('p3', 'downloading', { playlistId: 'PLxxx' }),
    ]);

    expect(activeItems).toHaveLength(1);
    expect(historyItems).toHaveLength(0);
    const item = activeItems[0];
    if (item?.kind === 'group') {
      expect(item.rows.map((r) => r.id)).toEqual(['p1', 'p2', 'p3']);
    }
  });

  it('routes a playlist group to history when every row is terminal', () => {
    const { activeItems, historyItems } = partitionRows([
      makeRow('p1', 'completed', { playlistId: 'PLxxx' }),
      makeRow('p2', 'completed', { playlistId: 'PLxxx' }),
      makeRow('p3', 'cancelled', { playlistId: 'PLxxx' }),
    ]);

    expect(activeItems).toHaveLength(0);
    expect(historyItems).toHaveLength(1);
    const item = historyItems[0];
    expect(item?.kind).toBe('group');
  });

  it('does NOT fold non-contiguous same-playlistId rows (two playlists with the same id end up as two groups — would only happen if input ordering broke)', () => {
    // Defense in depth — the rows array is supposed to be sorted by
    // createdAt, and a single playlist's rows are enqueued together
    // so they land contiguously. If something splits them, we'd see
    // two groups for the same id. Confirms the partition is
    // contiguous-only, not "all-rows-with-matching-id".
    const { activeItems } = partitionRows([
      makeRow('p1', 'queued', { playlistId: 'PLxxx', createdAt: 3 }),
      makeRow('solo', 'queued', { createdAt: 2 }),
      makeRow('p2', 'queued', { playlistId: 'PLxxx', createdAt: 1 }),
    ]);

    expect(activeItems).toHaveLength(3);
    expect(activeItems.map((i) => i.kind)).toEqual(['group', 'row', 'group']);
  });

  it('preserves newest-first ordering (input is already sorted; partition does not reorder)', () => {
    const { activeItems } = partitionRows([
      makeRow('a', 'downloading', { createdAt: 30 }),
      makeRow('b', 'queued', { createdAt: 20 }),
      makeRow('c', 'queued', { createdAt: 10 }),
    ]);

    expect(activeItems.map((i) => i.createdAt)).toEqual([30, 20, 10]);
  });

  it('uses the first row in the group as the group createdAt (newest in playlist)', () => {
    const { activeItems } = partitionRows([
      makeRow('p1', 'downloading', { playlistId: 'PLxxx', createdAt: 30 }),
      makeRow('p2', 'queued', { playlistId: 'PLxxx', createdAt: 29 }),
    ]);

    expect(activeItems[0]?.createdAt).toBe(30);
  });

  it('returns empty arrays for an empty input', () => {
    expect(partitionRows([])).toEqual({ activeItems: [], historyItems: [] });
  });

  it('interleaves standalone rows with playlist groups in the active section', () => {
    const { activeItems, historyItems } = partitionRows([
      makeRow('solo1', 'downloading', { createdAt: 40 }),
      makeRow('p1', 'queued', { playlistId: 'PLxxx', createdAt: 30 }),
      makeRow('p2', 'queued', { playlistId: 'PLxxx', createdAt: 29 }),
      makeRow('solo2', 'queued', { createdAt: 20 }),
    ]);

    expect(activeItems.map((i) => i.kind)).toEqual(['row', 'group', 'row']);
    expect(historyItems).toHaveLength(0);
  });
});

const itemKey = (item: ReturnType<typeof partitionRows>['activeItems'][number]): string => {
  if (item.kind === 'row') {
    return `row:${item.row.id}`;
  }
  const firstId = item.rows[0]?.id ?? '?';
  return `group:${firstId}`;
};
