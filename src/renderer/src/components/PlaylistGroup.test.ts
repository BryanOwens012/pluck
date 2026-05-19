import { describe, expect, it } from 'vitest';
import type { Download, DownloadStatus } from '../../../shared/types';
import { STATIC_FORMAT_CHOICES } from '../../../shared/types';
import {
  computeAggregateProgress,
  findCancellableRows,
  groupHasNonTerminalRows,
} from './playlist-group-helpers';

/** Minimal Download factory for tests. Mirrors what queue.enqueue
 * actually produces; we only fill the fields each helper consumes
 * (status, progress, playlistId) and stub the rest. */
const makeRow = (id: string, status: DownloadStatus, progress = 0): Download => ({
  id,
  url: `https://example.com/${id}`,
  format: STATIC_FORMAT_CHOICES.best,
  outputFolder: '/tmp/out',
  status,
  progress,
  createdAt: 1000,
});

describe('computeAggregateProgress', () => {
  it('returns 0 for an empty list (no NaN division)', () => {
    expect(computeAggregateProgress([])).toBe(0);
  });

  it('returns the single row progress for a 1-row group', () => {
    expect(computeAggregateProgress([makeRow('a', 'downloading', 50)])).toBe(50);
  });

  it('averages progress across a mixed group', () => {
    // 100 + 50 + 0 = 150 / 3 = 50
    expect(
      computeAggregateProgress([
        makeRow('a', 'completed', 100),
        makeRow('b', 'downloading', 50),
        makeRow('c', 'queued', 0),
      ]),
    ).toBe(50);
  });

  it('returns 100 when every row is completed', () => {
    expect(
      computeAggregateProgress([
        makeRow('a', 'completed', 100),
        makeRow('b', 'completed', 100),
        makeRow('c', 'completed', 100),
      ]),
    ).toBe(100);
  });

  it('clamps row progress to [0, 100] before averaging (defensive)', () => {
    // A row reporting 150% (rare yt-dlp glitch) gets clamped to 100 so it
    // doesn't drag the aggregate above 100.
    expect(
      computeAggregateProgress([makeRow('a', 'downloading', 150), makeRow('b', 'queued', 0)]),
    ).toBe(50);
  });

  it('treats NaN row progress as 0 (no NaN propagation into the average)', () => {
    expect(
      computeAggregateProgress([
        makeRow('a', 'downloading', Number.NaN),
        makeRow('b', 'completed', 100),
      ]),
    ).toBe(50);
  });
});

describe('findCancellableRows', () => {
  it('returns rows in queued / downloading / needs_password', () => {
    const rows = [
      makeRow('a', 'queued'),
      makeRow('b', 'downloading'),
      makeRow('c', 'needs_password'),
      makeRow('d', 'completed'),
    ];
    expect(findCancellableRows(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('excludes canceling rows (cancel() is a no-op there — process already torn down)', () => {
    // Re-firing cancel() on a `canceling` row would just resend SIGTERM
    // at a yt-dlp process already winding down. The group-level button
    // dispatches per-row cancels, so we want to skip these.
    expect(findCancellableRows([makeRow('a', 'canceling')])).toEqual([]);
  });

  it('excludes terminal rows (completed / failed / cancelled)', () => {
    expect(
      findCancellableRows([
        makeRow('a', 'completed'),
        makeRow('b', 'failed'),
        makeRow('c', 'cancelled'),
      ]),
    ).toEqual([]);
  });

  it('excludes transcribing rows (post-download phase, not yt-dlp anymore)', () => {
    expect(findCancellableRows([makeRow('a', 'transcribing')])).toEqual([]);
  });

  it('returns [] for an empty list', () => {
    expect(findCancellableRows([])).toEqual([]);
  });
});

describe('groupHasNonTerminalRows', () => {
  it('returns true when any row is non-terminal', () => {
    expect(groupHasNonTerminalRows([makeRow('a', 'completed'), makeRow('b', 'downloading')])).toBe(
      true,
    );
  });

  it('returns false when every row is terminal (completed / cancelled / failed)', () => {
    expect(
      groupHasNonTerminalRows([
        makeRow('a', 'completed'),
        makeRow('b', 'cancelled'),
        makeRow('c', 'failed'),
      ]),
    ).toBe(false);
  });

  it('treats canceling as non-terminal (SIGTERM in flight, not yet cancelled)', () => {
    // canceling is the in-between state — the queue's cancel() emitted
    // it but the yt-dlp process hasn't exited yet. The group still
    // belongs in the active section until the row hits 'cancelled'.
    expect(groupHasNonTerminalRows([makeRow('a', 'canceling')])).toBe(true);
  });

  it('treats needs_password as non-terminal (row is waiting on the user)', () => {
    expect(groupHasNonTerminalRows([makeRow('a', 'needs_password')])).toBe(true);
  });

  it('returns false for an empty group (defensive — caller should not pass [])', () => {
    expect(groupHasNonTerminalRows([])).toBe(false);
  });
});
