import type { Download } from '../../../shared/types';

type Props = {
  download: Download;
};

const STATUS_LABEL: Record<Download['status'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  completed: 'Completed',
  failed: 'Failed',
  transcribing: 'Transcribing',
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

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-neutral-100">{headerTitle}</div>
          {download.sourceSite ? (
            <div className="mt-0.5 text-xs text-neutral-500">{download.sourceSite}</div>
          ) : null}
        </div>
        <div className="shrink-0 text-xs text-neutral-400">{STATUS_LABEL[download.status]}</div>
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
            <div className="text-xs text-neutral-500">Starting…</div>
          )}
        </div>
      ) : null}

      {download.status === 'completed' && download.filePath ? (
        <div className="mt-2 truncate text-xs text-emerald-400">Saved to {download.filePath}</div>
      ) : null}

      {download.status === 'failed' && download.error ? (
        <div className="mt-2 text-xs text-red-400">{download.error}</div>
      ) : null}
    </div>
  );
};
