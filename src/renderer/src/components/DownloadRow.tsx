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

export const DownloadRow = ({ download }: Props): React.JSX.Element => {
  const headerTitle = download.title ?? download.url;
  const percent = Math.max(
    0,
    Math.min(100, Number.isFinite(download.progress) ? download.progress : 0),
  );

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
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full bg-neutral-100 transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-neutral-500">
            <span>{formatPercent(download.progress)}</span>
            <span>
              {download.speed ?? '—'} · ETA {download.eta ?? '—'}
            </span>
          </div>
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
