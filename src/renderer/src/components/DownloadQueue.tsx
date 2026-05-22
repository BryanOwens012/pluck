import type { DebugLogEvent, Download, PlaylistContext } from '../../../shared/types';
import { DownloadRow } from './DownloadRow';
import { partitionRows, type QueueItem } from './download-queue-partition';
import { PlaylistGroup } from './PlaylistGroup';
import { PlaylistGroupPlaceholder } from './PlaylistGroupPlaceholder';

type Props = {
  /** Newest-first list of downloads (history + live). Empty + no
   * pending enumerations renders the paste-a-URL hint. */
  rows: Download[];
  /** Playlist enumerations the user kicked off but yt-dlp hasn't yet
   * expanded into individual rows. Renders as a placeholder accordion
   * at the top of the active section — gives the user instant
   * feedback that the "All videos" click landed, instead of a 5-10 s
   * blank screen while `yt-dlp -J --flat-playlist` runs. App removes
   * each entry on the success path (rows have been broadcast); on
   * the failure path App sets `error` on the entry instead so the
   * placeholder flips into the red error state and stays until the
   * user dismisses. */
  pendingEnumerations?: { id: string; context: PlaylistContext | undefined; error?: string }[];
  /** Called when the user clicks Dismiss on a failed-enumerate
   * placeholder. App removes the entry from `pendingEnumerations`. */
  onDismissPendingEnumeration?: (id: string) => void;
  /** Forwarded to each row; opens the password prompt for that id. App
   * owns the prompt state. */
  onOpenPasswordPrompt?: (id: string) => void;
  /** Forwarded to each row — gates the Transcribe button on completed
   * downloads. App reads this off persisted settings. */
  transcriptionEnabled?: boolean;
  /** Debug-mode flag — toggles the folder button + log box on each row. */
  debugMode?: boolean;
  /** Per-id log buffers. App caps each buffer at MAX_LOG_LINES before
   * passing the slice down. */
  debugLogs?: ReadonlyMap<string, readonly DebugLogEvent[]>;
};

/** Renders the queue. Behavior:
 *
 *  - In-flight `enumeratePlaylist` calls render as
 *    `PlaylistGroupPlaceholder` accordions at the TOP of the active
 *    section, before any real rows. Once the IPC chain resolves they
 *    drop out and the real `PlaylistGroup` takes over inline.
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
  pendingEnumerations = [],
  onDismissPendingEnumeration,
  onOpenPasswordPrompt,
  transcriptionEnabled,
  debugMode,
  debugLogs,
}: Props): React.JSX.Element => {
  if (rows.length === 0 && pendingEnumerations.length === 0) {
    return <p className="text-sm text-neutral-700">Paste a video URL above to start a download.</p>;
  }

  const renderRow = (download: Download): React.JSX.Element => (
    <DownloadRow
      key={download.id}
      download={download}
      onOpenPasswordPrompt={onOpenPasswordPrompt}
      transcriptionEnabled={transcriptionEnabled}
      debugMode={debugMode}
      debugLog={debugLogs?.get(download.id)}
    />
  );

  const { activeItems, historyItems } = partitionRows(rows);
  const hasActiveSection = pendingEnumerations.length > 0 || activeItems.length > 0;

  return (
    <div>
      {hasActiveSection ? (
        <div className="space-y-2">
          {pendingEnumerations.map((entry) => (
            <PlaylistGroupPlaceholder
              key={entry.id}
              context={entry.context}
              error={entry.error}
              onDismiss={
                onDismissPendingEnumeration
                  ? () => onDismissPendingEnumeration(entry.id)
                  : undefined
              }
            />
          ))}
          {activeItems.map((item) => renderItem(item, renderRow))}
        </div>
      ) : null}
      {historyItems.length > 0 ? (
        <section className="mt-10 space-y-3 border-t border-neutral-200 pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-700">
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
