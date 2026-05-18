import { useState } from 'react';
import type { Download } from '../../../shared/types';
import { api } from '../lib/api';
import { resolveSiteGlyph, SourceSiteIcon } from './SourceSiteIcon';

type Props = {
  download: Download;
  /** Open the password prompt for this row. App owns the modal state;
   * the row only signals "user wants to enter the password now". Used
   * to reopen a dismissed prompt without waiting for the next status
   * transition. */
  onOpenPasswordPrompt?: (id: string) => void;
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
  canceling: 'Canceling…',
  needs_password: 'Needs password',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  transcribing: 'Transcribing',
};

// Tailwind classes for the small status badge in the row header. Failed gets
// red so the row reads as broken at a glance even before the user reads the
// error message below. Canceling/cancelled stay neutral — both are the
// user's choice, not an error. Needs-password uses amber to read as
// "action required" without claiming the row has actually failed.
const STATUS_BADGE_CLASS: Record<Download['status'], string> = {
  queued: 'text-neutral-400',
  downloading: 'text-neutral-400',
  canceling: 'text-neutral-500',
  needs_password: 'text-amber-400',
  completed: 'text-neutral-400',
  failed: 'text-red-400',
  cancelled: 'text-neutral-500',
  transcribing: 'text-neutral-400',
};

const formatPercent = (value: number): string =>
  Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';

const clampPercent = (value: number): number =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

export const DownloadRow = ({ download, onOpenPasswordPrompt }: Props): React.JSX.Element => {
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
    <div className="flex gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
      {download.thumbnailUrl ? <Thumbnail url={download.thumbnailUrl} /> : null}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-medium text-neutral-100">{headerTitle}</div>
            {download.sourceSite ? (
              <SourceSiteBadge siteKey={download.sourceSite} url={download.url} />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {download.status === 'downloading' ? <CancelButton id={download.id} /> : null}
            <div className={`text-xs ${STATUS_BADGE_CLASS[download.status]}`}>
              {STATUS_LABEL[download.status]}
            </div>
          </div>
        </div>

        {download.status === 'downloading' || download.status === 'canceling' ? (
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

        {/* needs_password footer: amber to read as "action required" rather
            than a failure. The auto-popped modal handles the happy path;
            this button reopens it if the user dismissed. */}
        {download.status === 'needs_password' && onOpenPasswordPrompt ? (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-900/70 bg-amber-950/40 p-2.5">
            <span aria-hidden="true" className="select-none text-sm leading-none text-amber-400">
              🔒
            </span>
            <div className="min-w-0 flex-1 text-xs text-amber-300">
              This recording is password-protected.
            </div>
            <button
              type="button"
              onClick={() => onOpenPasswordPrompt(download.id)}
              className="shrink-0 rounded-md border border-amber-800/70 bg-amber-950/40 px-2 py-0.5 text-xs font-medium text-amber-300 transition hover:bg-amber-900/40 focus:outline-none focus-visible:bg-amber-900/40"
            >
              Enter password
            </button>
          </div>
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
            <RetryButton id={download.id} />
          </div>
        ) : null}
      </div>
    </div>
  );
};

// Shared classes for the thumbnail's visible box. h-12 w-20 keeps a 16:9
// aspect ratio at small size; bg-neutral-800 is the placeholder colour that
// shows while loading and again if the image fails. Pulled out so the <img>
// and its fallback placeholder can't drift apart.
const THUMBNAIL_BOX_CLASS = 'h-12 w-20 shrink-0 rounded bg-neutral-800';

/** Preview thumbnail rendered to the left of the row body. Fixed 16:9 box so
 * rows stay vertically aligned regardless of which thumbnails happen to load.
 * `onError` flips to the placeholder so a CDN miss falls back to the empty
 * box instead of a broken-image icon. */
const Thumbnail = ({ url }: { url: string }): React.JSX.Element => {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className={THUMBNAIL_BOX_CLASS} aria-hidden="true" />;
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={`${THUMBNAIL_BOX_CLASS} object-cover`}
    />
  );
};

/** Clickable site-badge: extractor monogram + plain-text label. Click opens
 * the original URL in the user's default browser. The whole thing is one
 * button so the hit target is generous; styled subtly so it reads as a hint
 * rather than a CTA. */
const SourceSiteBadge = ({ siteKey, url }: { siteKey: string; url: string }): React.JSX.Element => {
  const handleOpen = (): void => {
    api.openExternal(url).catch((err: unknown) => {
      console.error('openExternal rejected:', err);
    });
  };
  // Tooltip uses the resolved label ("YouTube" not "youtube:tab") so it reads
  // cleanly when yt-dlp's extractor key carries a colon-suffix.
  const tooltipLabel = resolveSiteGlyph(siteKey).label;
  return (
    <button
      type="button"
      onClick={handleOpen}
      title={`Open on ${tooltipLabel} in your browser`}
      className="mt-0.5 inline-flex items-center gap-1.5 rounded text-xs text-neutral-500 transition hover:text-neutral-300 focus:outline-none focus-visible:text-neutral-300"
    >
      <SourceSiteIcon siteKey={siteKey} />
      <span>{siteKey}</span>
    </button>
  );
};

/** Re-runs a failed download with the same URL + format, creating a new
 * row (fresh id, fresh createdAt). The original failed row stays in the
 * list so the user can see they tried before. */
const RetryButton = ({ id }: { id: string }): React.JSX.Element => {
  const handleRetry = (): void => {
    api.retryDownload(id).catch((err: unknown) => {
      console.error('retryDownload rejected:', err);
    });
  };
  return (
    <button
      type="button"
      onClick={handleRetry}
      title="Retry download"
      aria-label="Retry download"
      className="shrink-0 self-start rounded-md border border-red-900/70 bg-red-950/40 px-2 py-0.5 text-xs font-medium text-red-300 transition hover:bg-red-900/50 hover:text-red-200 focus:outline-none focus-visible:bg-red-900/50"
    >
      Retry
    </button>
  );
};

/** Red cancel button shown next to the status badge while a download is
 * active. Click → api.cancelDownload(id); main process sends SIGTERM to
 * yt-dlp (then SIGKILL after 2 s), the row's status flips to 'cancelled',
 * and the temp workspace is wiped via the existing try/finally. */
const CancelButton = ({ id }: { id: string }): React.JSX.Element => {
  const handleCancel = (): void => {
    api.cancelDownload(id).catch((err: unknown) => {
      console.error('cancelDownload rejected:', err);
    });
  };
  return (
    <button
      type="button"
      onClick={handleCancel}
      title="Cancel download"
      aria-label="Cancel download"
      className="rounded-md border border-red-900/70 bg-red-950/40 px-2 py-0.5 text-xs font-medium text-red-300 transition hover:bg-red-900/50 hover:text-red-200 focus:outline-none focus-visible:bg-red-900/50"
    >
      Cancel
    </button>
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
