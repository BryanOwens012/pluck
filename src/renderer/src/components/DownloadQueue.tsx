import type { DebugLogEvent, Download } from '../../../shared/types';
import { DownloadRow } from './DownloadRow';
import { partitionRows, type QueueItem } from './download-queue-partition';
import { PlaylistGroup } from './PlaylistGroup';

type Props = {
  /** Newest-first list of downloads (history + live). Empty renders the
   * paste-a-URL hint instead of an empty container. */
  rows: Download[];
  /** Forwarded to each row; opens the password prompt for that id. App
   * owns the prompt state. */
  onOpenPasswordPrompt?: (id: string) => void;
  /** Debug-mode flag — toggles the folder button + log box on each row. */
  debugMode?: boolean;
  /** Per-id log buffers. App caps each buffer at MAX_LOG_LINES before
   * passing the slice down. */
  debugLogs?: ReadonlyMap<string, readonly DebugLogEvent[]>;
};

/** Renders the queue. Behavior:
 *
 *  - Contiguous same-`playlistId` rows fold into a `PlaylistGroup`
 *    accordion that owns the rows whether they're active OR terminal
 *    — the playlist is presented as one unit so the user doesn't see
 *    its title duplicated across the active/history boundary.
 *  - Standalone (non-playlist) rows split into the active / History
 *    sections per their individual status, same as before.
 *  - A playlist group lands in active iff ANY of its rows is still
 *    non-terminal; once every row has finished, the whole group
 *    drops into History. */
export const DownloadQueue = ({
  rows,
  onOpenPasswordPrompt,
  debugMode,
  debugLogs,
}: Props): React.JSX.Element => {
  if (rows.length === 0) {
    return <p className="text-sm text-neutral-500">Paste a video URL above to start a download.</p>;
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

  const { activeItems, historyItems } = partitionRows(rows);

  return (
    <div>
      {activeItems.length > 0 ? (
        <div className="space-y-2">{activeItems.map((item) => renderItem(item, renderRow))}</div>
      ) : null}
      {historyItems.length > 0 ? (
        <section className="mt-10 space-y-3 border-t border-neutral-800 pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            History
          </h2>
          <div className="space-y-2">{historyItems.map((item) => renderItem(item, renderRow))}</div>
        </section>
      ) : null}
    </div>
  );
};

const renderItem = (
  item: QueueItem,
  renderRow: (d: Download) => React.JSX.Element,
): React.JSX.Element => {
  if (item.kind === 'row') {
    return renderRow(item.row);
  }
  const firstId = item.rows[0]?.playlistId ?? 'group';
  return <PlaylistGroup key={`playlist-${firstId}`} rows={item.rows} renderRow={renderRow} />;
};
