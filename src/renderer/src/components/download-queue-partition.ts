import type { Download } from '../../../shared/types';
import { groupHasNonTerminalRows, TERMINAL_STATUSES } from './playlist-group-helpers';

/** Discriminated union of "things the queue lists". Either a single
 * standalone row, or a playlist group holding its constituent rows.
 * Both carry `createdAt` so the renderer can sort them newest-first
 * uniformly regardless of kind. For groups, `createdAt` is the first
 * row's value (i.e. the newest entry in the playlist — since rows
 * are already sorted newest-first inside the group). */
export type QueueItem =
  | { kind: 'row'; row: Download; createdAt: number }
  | { kind: 'group'; rows: Download[]; createdAt: number };

/** Walk the (already-newest-first) rows once, fold contiguous same-
 * `playlistId` runs into group items, then split items into active vs
 * history by group / row terminal status. Newest-first order is
 * preserved within each section because the input was already sorted
 * and the partition step preserves source order.
 *
 * A playlist group lands in `activeItems` iff ANY of its rows is
 * still non-terminal — so a playlist with mixed statuses (some
 * completed, some downloading) stays presented as one unit at the
 * top of the queue, rather than splitting its rows across the
 * active/History boundary. The whole group migrates to `historyItems`
 * only once every row has reached a terminal status. */
export const partitionRows = (
  rows: Download[],
): { activeItems: QueueItem[]; historyItems: QueueItem[] } => {
  const activeItems: QueueItem[] = [];
  const historyItems: QueueItem[] = [];

  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row === undefined) {
      i += 1;
      continue;
    }
    if (row.playlistId === undefined) {
      const item: QueueItem = { kind: 'row', row, createdAt: row.createdAt };
      (TERMINAL_STATUSES.has(row.status) ? historyItems : activeItems).push(item);
      i += 1;
      continue;
    }
    // Collect the contiguous run of same-playlistId rows.
    const groupId = row.playlistId;
    const group: Download[] = [];
    while (i < rows.length && rows[i]?.playlistId === groupId) {
      const next = rows[i];
      if (next !== undefined) {
        group.push(next);
      }
      i += 1;
    }
    const firstInGroup = group[0];
    if (firstInGroup === undefined) {
      continue;
    }
    const item: QueueItem = { kind: 'group', rows: group, createdAt: firstInGroup.createdAt };
    (groupHasNonTerminalRows(group) ? activeItems : historyItems).push(item);
  }

  return { activeItems, historyItems };
};
