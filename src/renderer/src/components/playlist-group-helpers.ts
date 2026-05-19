import type { Download, DownloadStatus } from '../../../shared/types';

/** Row statuses where the queue's `cancel()` does something meaningful.
 * `canceling` is excluded — the row already has a SIGTERM in flight;
 * re-firing cancel() is a no-op there. `transcribing` is also excluded
 * (post-download phase, not yt-dlp anymore). Used by the group-level
 * Cancel-all button to decide which rows to dispatch to. */
const CANCELLABLE_STATUSES = new Set<DownloadStatus>(['queued', 'downloading', 'needs_password']);

/** Terminal statuses for the queue's active-vs-history decision. A
 * standalone row lands in History when it's in this set; a playlist
 * group lands in History only when ALL its rows are in this set so
 * the user sees the playlist as one unit until every row is done.
 * Exported so the partition module shares one source of truth. */
export const TERMINAL_STATUSES = new Set<DownloadStatus>(['completed', 'cancelled', 'failed']);

/** Aggregate progress across the rows in a playlist group. Plain
 * average of `row.progress` (0-100, clamped + NaN-guarded). Returns 0
 * for an empty list so the bar renders at 0% instead of `NaN%`. */
export const computeAggregateProgress = (rows: readonly Download[]): number => {
  if (rows.length === 0) {
    return 0;
  }
  const sum = rows.reduce((acc, r) => acc + clampPercent(r.progress), 0);
  return sum / rows.length;
};

/** Subset of rows the group-level Cancel-all button should dispatch
 * to. Skipping `canceling` rows avoids spamming SIGTERM at a process
 * that's already being torn down; skipping terminal rows avoids
 * showing a "cancel" affordance for things that are already done. */
export const findCancellableRows = (rows: readonly Download[]): Download[] => {
  return rows.filter((r) => CANCELLABLE_STATUSES.has(r.status));
};

/** True when at least one row in the group is still in motion (not in
 * a terminal status). Drives both the default-expanded state of the
 * accordion and the active-vs-history routing decision. */
export const groupHasNonTerminalRows = (rows: readonly Download[]): boolean => {
  return rows.some((r) => !TERMINAL_STATUSES.has(r.status));
};

const clampPercent = (n: number): number => {
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n < 0) {
    return 0;
  }
  if (n > 100) {
    return 100;
  }
  return n;
};
