import { useState } from 'react';
import type { Download } from '../../../shared/types';
import { api } from '../lib/api';
import {
  computeAggregateProgress,
  findCancellableRows,
  groupHasNonTerminalRows,
} from './playlist-group-helpers';

type Props = {
  /** Contiguous run of rows that share a `playlistId`. The renderer
   * has already ordered them newest-first; the group renders them in
   * that order inside its expanded body. */
  rows: Download[];
  /** Per-row renderer the parent passes in so this component doesn't
   * need to know about DownloadRow's prop wiring (password prompt
   * callbacks, debug logs, etc.). */
  renderRow: (d: Download) => React.JSX.Element;
};

/** Collapsible accordion for one playlist's rows.
 *
 * Header layout:
 *   ▼ <Playlist title>         X of M   [Cancel all]
 *   [aggregate progress bar]   N%
 *
 * The expanded body lists the individual `DownloadRow`s, each with
 * its own per-row Cancel button (untouched by this component).
 *
 * **Default expanded state**: open when any row is still non-terminal
 * (the user is presumably watching it download); closed when every
 * row has terminated (history-section context). The user can override
 * by clicking the header — local state, not persisted.
 *
 * **Cancel all**: dispatches `api.cancelDownload(id)` for every row in
 * `CANCELLABLE_STATUSES`. The button hides when none qualify, so a
 * group whose rows are all finished / cancelled doesn't show a
 * misleading button. */
export const PlaylistGroup = ({ rows, renderRow }: Props): React.JSX.Element | null => {
  // Default-open computed once from the initial row set. Subsequent
  // status changes don't reopen the group automatically — user
  // collapse intent wins over "a row finished".
  const [expanded, setExpanded] = useState<boolean>(() => groupHasNonTerminalRows(rows));

  const first = rows[0];
  if (first === undefined) {
    return null;
  }
  const title = first.playlistTitle ?? 'Playlist';
  const total = first.playlistTotal ?? rows.length;
  const aggregate = computeAggregateProgress(rows);
  const cancellable = findCancellableRows(rows);
  const hasCancellable = cancellable.length > 0;

  const handleToggle = (): void => {
    setExpanded((prev) => !prev);
  };

  const handleCancelAll = (): void => {
    for (const row of cancellable) {
      api.cancelDownload(row.id).catch((err: unknown) => {
        console.error('cancelDownload rejected:', err);
      });
    }
  };

  return (
    <section className="rounded-lg border border-neutral-200 bg-neutral-100/40 p-3">
      {/* Header is a flex row of sibling controls — the chevron + title
          toggle button is one element, and the Cancel-all button is a
          separate sibling so nothing nests buttons (invalid HTML +
          breaks keyboard nav). */}
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} playlist ${title}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
        >
          <Chevron expanded={expanded} />
          <h3 className="min-w-0 flex-1 break-words text-xs font-semibold text-neutral-800">
            {title}
          </h3>
          <span className="shrink-0 text-xs text-neutral-700">
            {rows.length} of {total}
          </span>
        </button>
        {hasCancellable ? (
          <button
            type="button"
            onClick={handleCancelAll}
            title="Cancel all in-flight rows in this playlist"
            aria-label={`Cancel all ${cancellable.length} in-flight rows in playlist ${title}`}
            className="shrink-0 rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 transition hover:bg-red-100 hover:text-red-800 focus:outline-none focus-visible:bg-red-100"
          >
            Cancel all
          </button>
        ) : null}
      </header>

      <div className="mt-2 flex items-center gap-2">
        <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-neutral-200">
          <div
            className="h-full bg-neutral-900 transition-all"
            style={{ width: `${aggregate}%` }}
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-neutral-700">
          {Math.round(aggregate)}%
        </span>
      </div>

      {expanded ? <div className="mt-3 space-y-2">{rows.map(renderRow)}</div> : null}
    </section>
  );
};

/** Tiny inline SVG chevron. Rotates 90° when expanded so the same
 * shape doubles as both the collapsed (▶) and expanded (▼) marker. */
const Chevron = ({ expanded }: { expanded: boolean }): React.JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={`h-3 w-3 shrink-0 text-neutral-700 transition-transform ${
      expanded ? 'rotate-90' : ''
    }`}
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);
