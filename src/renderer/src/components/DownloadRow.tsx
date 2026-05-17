import type { Download } from '../../../shared/types';
import { api } from '../lib/api';

type Props = {
  download: Download;
};

/** Lucide-style folder icon, inlined to avoid pulling in an icon dep just
 * for this. 16×16 at 2px stroke renders crisply against the dark theme. */
const FolderIcon = (): React.JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="h-4 w-4"
  >
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

const STATUS_LABEL: Record<Download['status'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  completed: 'Completed',
  failed: 'Failed',
  transcribing: 'Transcribing',
};

// Tailwind classes for the small status badge in the row header. Failed gets
// red so the row reads as broken at a glance even before the user reads the
// error message below. Error display is always on — never gated on debug
// mode.
const STATUS_BADGE_CLASS: Record<Download['status'], string> = {
  queued: 'text-neutral-400',
  downloading: 'text-neutral-400',
  completed: 'text-neutral-400',
  failed: 'text-red-400',
  transcribing: 'text-neutral-400',
};

const formatPercent = (value: number): string =>
  Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';

const clampPercent = (value: number): number =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

export const DownloadRow = ({ download }: Props): React.JSX.Element => {
  const headerTitle = download.title ?? download.url;
  const percent = clampPercent(download.progress);
  // Once yt-dlp reports any non-zero percent we switch to a determinate
  // fill; until then the bar animates an indeterminate slide so the user
  // sees activity rather than a stuck-at-zero bar.
  const hasDeterminateProgress = percent > 0;
  // Three distinct sub-phases inside `status === 'downloading'`. yt-dlp's
  // metadata fetch (especially the YouTube JS-challenge step) can take
  // 2-4 s on a cold start; calling that out as "Reading video info" beats
  // letting the user stare at "Starting…" for several seconds.
  const isFetchingMetadata = download.title === undefined;
  const startingLabel = isFetchingMetadata ? 'Reading video info…' : 'Starting download…';

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm font-medium text-neutral-100">{headerTitle}</div>
          {download.sourceSite ? (
            <div className="mt-0.5 text-xs text-neutral-500">{download.sourceSite}</div>
          ) : null}
        </div>
        <div className={`shrink-0 text-xs ${STATUS_BADGE_CLASS[download.status]}`}>
          {STATUS_LABEL[download.status]}
        </div>
      </div>

      {download.status === 'downloading' ? (
        <div className="mt-3 space-y-1.5">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-neutral-800">
            {hasDeterminateProgress ? (
              <div
                className="h-full bg-neutral-100 transition-all"
                style={{ width: `${percent}%` }}
              />
            ) : (
              <div className="pluck-progress-indeterminate absolute inset-y-0 left-0 w-1/3 bg-neutral-100" />
            )}
          </div>
          {hasDeterminateProgress ? (
            <div className="flex justify-between text-xs text-neutral-500">
              <span>{formatPercent(download.progress)}</span>
              <span>
                {download.speed ?? '—'} · ETA {download.eta ?? '—'}
              </span>
            </div>
          ) : (
            <div className="text-xs text-neutral-500">{startingLabel}</div>
          )}
        </div>
      ) : null}

      {download.status === 'completed' && download.filePath ? (
        <CompletedFooter filePath={download.filePath} />
      ) : null}

      {/* Failed-state error block; always shown regardless of debug mode. */}
      {download.status === 'failed' && download.error ? (
        <div className="mt-3 flex gap-2 rounded-md border border-red-900/70 bg-red-950/40 p-2.5">
          <span aria-hidden="true" className="select-none text-sm leading-none text-red-400">
            ⚠
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-red-300">Download failed</div>
            <div className="mt-0.5 break-words text-xs text-red-300/90">{download.error}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** Saved-to line plus a folder-icon button that reveals the file in Finder.
 * Extracted so the narrowed `filePath: string` (vs the parent's optional)
 * stays clean inside the button's click handler. */
const CompletedFooter = ({ filePath }: { filePath: string }): React.JSX.Element => {
  const handleReveal = (): void => {
    api.showInFinder(filePath).catch((err: unknown) => {
      console.error('showInFinder rejected:', err);
    });
  };

  return (
    <div className="mt-2 flex items-start gap-2">
      <div className="min-w-0 flex-1 break-words text-xs text-emerald-400">Saved to {filePath}</div>
      <button
        type="button"
        onClick={handleReveal}
        title="Show in Finder"
        aria-label="Show in Finder"
        className="shrink-0 rounded p-1 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
      >
        <FolderIcon />
      </button>
    </div>
  );
};
