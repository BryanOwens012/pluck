import type { DebugLogEvent, Download, DownloadStatus } from '../../../shared/types';
import { DownloadRow } from './DownloadRow';

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

/** Terminal statuses — these rows belong under "History", separated from
 * the live queue. Anything not in this set (queued / downloading /
 * canceling / needs_password / transcribing) is still in motion and
 * shown above the History section. */
const HISTORY_STATUSES = new Set<DownloadStatus>(['completed', 'cancelled', 'failed']);

/** Renders the queue split into an active section (in-flight downloads)
 * and a History section (terminal rows). Pure presentational — App owns
 * the state and sort order. */
export const DownloadQueue = ({
  rows,
  onOpenPasswordPrompt,
  debugMode,
  debugLogs,
}: Props): React.JSX.Element => {
  if (rows.length === 0) {
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

  return (
    <div>
      {activeRows.length > 0 ? <div className="space-y-2">{activeRows.map(renderRow)}</div> : null}
      {historyRows.length > 0 ? (
        <section className="mt-10 space-y-3 border-t border-neutral-800 pt-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            History
          </h2>
          <div className="space-y-2">{historyRows.map(renderRow)}</div>
        </section>
      ) : null}
    </div>
  );
};
