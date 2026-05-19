import type {
  DebugLogEvent,
  Download,
  DownloadStatus,
  PlaylistContext,
} from '../../../shared/types';
import { DownloadRow } from './DownloadRow';
import { PlaylistGroupPlaceholder } from './PlaylistGroupPlaceholder';

type Props = {
  /** Newest-first list of downloads (history + live). Empty renders the
   * paste-a-URL hint instead of an empty container. */
  rows: Download[];
  /** Playlist enumerations the user kicked off but yt-dlp hasn't yet
   * expanded into individual rows. Renders as a placeholder accordion
   * above the active section — gives the user instant feedback that
   * the "All videos" click landed, instead of a 5-10 s blank screen
   * while `yt-dlp -J --flat-playlist` runs. App removes each entry in
   * the IPC chain's `finally`, by which time either the real rows are
   * showing up here or the enumerate has failed. */
  pendingEnumerations?: { id: string; context: PlaylistContext | undefined }[];
  /** Forwarded to each row; opens the password prompt for that id. App
   * owns the prompt state. */
  onOpenPasswordPrompt?: (id: string) => void;
  /** Debug-mode flag — toggles the folder button + log box on each row. */
  debugMode?: boolean;
  /** Per-id log buffers. App caps each buffer at MAX_LOG_LINES before
   * passing the slice down. */
  debugLogs?: ReadonlyMap<string, readonly DebugLogEvent[]>;
};

/** Terminal statuses — these rows belong under "History", separated from
 * the live queue. Anything not in this set (queued / downloading /
 * canceling / needs_password / transcribing) is still in motion and
 * shown above the History section. */
const HISTORY_STATUSES = new Set<DownloadStatus>(['completed', 'cancelled', 'failed']);

/** Renders the queue split into an active section (in-flight downloads)
 * and a History section (terminal rows). Within each section, rows that
 * belong to the same playlist are grouped under a playlist header so
 * the user sees the playlist as a unit instead of N disjoint rows. */
export const DownloadQueue = ({
  rows,
  pendingEnumerations = [],
  onOpenPasswordPrompt,
  debugMode,
  debugLogs,
}: Props): React.JSX.Element => {
  if (rows.length === 0 && pendingEnumerations.length === 0) {
    return <p className="text-sm text-neutral-500">Paste a video URL above to start a download.</p>;
  }

  const activeRows: Download[] = [];
  const historyRows: Download[] = [];
  for (const row of rows) {
    if (HISTORY_STATUSES.has(row.status)) {
      historyRows.push(row);
    } else {
      activeRows.push(row);
    }
  }

  const renderRow = (download: Download): React.JSX.Element => (
    <DownloadRow
      key={download.id}
      download={download}
      onOpenPasswordPrompt={onOpenPasswordPrompt}
      debugMode={debugMode}
      debugLog={debugLogs?.get(download.id)}
    />
  );

  const hasActiveSection = pendingEnumerations.length > 0 || activeRows.length > 0;

  return (
    <div>
      {hasActiveSection ? (
        <div className="space-y-2">
          {/* Placeholders render at the top of the active section so the
              user sees instant feedback after "All videos". Real
              PlaylistGroups for any rows that ARE already enqueued
              render below — typically there are none yet (enumerate is
              still in flight) but the layout handles mixed cases too. */}
          {pendingEnumerations.map((entry) => (
            <PlaylistGroupPlaceholder key={entry.id} context={entry.context} />
          ))}
          {renderGroupedRows(activeRows, renderRow)}
        </div>
      ) : null}
      {historyRows.length > 0 ? (
        <section className="mt-10 space-y-3 border-t border-neutral-800 pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            History
          </h2>
          <div className="space-y-2">{renderGroupedRows(historyRows, renderRow)}</div>
        </section>
      ) : null}
    </div>
  );
};

/** Walk a row list once and emit alternating "playlist group" blocks and
 * standalone rows. Rows whose `playlistId` matches the previous row's
 * are folded into the current group's body; standalone rows render
 * inline as before. Stable / order-preserving — never reorders inputs.
 *
 * Grouping is order-sensitive: only contiguous matching `playlistId`s
 * fold. The caller sorts rows newest-first; playlist entries enqueued
 * in one go have createdAt-stamps within milliseconds of each other,
 * so they land contiguously in the sorted list. */
const renderGroupedRows = (
  rows: Download[],
  renderRow: (d: Download) => React.JSX.Element,
): React.JSX.Element[] => {
  const out: React.JSX.Element[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row === undefined) {
      i += 1;
      continue;
    }
    if (row.playlistId === undefined) {
      out.push(renderRow(row));
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
    out.push(<PlaylistGroup key={`playlist-${groupId}`} rows={group} renderRow={renderRow} />);
  }
  return out;
};

/** Header + indented body for one playlist's rows. Header reads
 * "<playlist title> · X of M" where X is the count of rows in THIS
 * section (active or history) and M is the playlistTotal stamped at
 * enqueue. Active + history counts sum to ≤ M (rows that haven't
 * finished are in active; terminal rows are in history). */
const PlaylistGroup = ({
  rows,
  renderRow,
}: {
  rows: Download[];
  renderRow: (d: Download) => React.JSX.Element;
}): React.JSX.Element => {
  const first = rows[0];
  if (first === undefined) {
    return <></>;
  }
  const title = first.playlistTitle ?? 'Playlist';
  const total = first.playlistTotal ?? rows.length;

  return (
    <section className="space-y-2 rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 break-words text-xs font-semibold text-neutral-300">{title}</h3>
        <span className="shrink-0 text-xs text-neutral-500">
          {rows.length} of {total}
        </span>
      </header>
      <div className="space-y-2">{rows.map(renderRow)}</div>
    </section>
  );
};
