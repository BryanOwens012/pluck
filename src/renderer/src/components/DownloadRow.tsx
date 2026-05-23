import { useEffect, useState } from 'react';
import { ELEVENLABS_ENABLED } from '../../../shared/flags';
import type { BrowserName, DebugLogEvent, Download } from '../../../shared/types';
import { api } from '../lib/api';
import { LogBox } from './LogBox';
import { resolveSiteGlyph, SourceSiteIcon } from './SourceSiteIcon';

/** Display labels for the BrowserName values. Shown in the inline
 * picker so the user sees "Chrome" / "Brave" rather than the lowercase
 * IPC slugs. Order in the picker comes from `detectInstalledBrowsers`
 * (which returns the BROWSER_NAMES subset present on disk). */
const BROWSER_DISPLAY: Record<BrowserName, string> = {
  chrome: 'Chrome',
  firefox: 'Firefox',
  safari: 'Safari',
  brave: 'Brave',
  edge: 'Edge',
};

const MISSING_FILE_TOOLTIP = 'The video cannot be found, as it might have been moved or deleted.';

/** Split a file path into its stem (everything up to but not including
 * the final extension) and its dot-prefixed extension ("mp4" → ".mp4"
 * with the dot included so callers can color the whole `.ext` suffix
 * as one unit). Returns an empty `dotExt` for files with no extension
 * or for paths whose last segment is itself dot-prefixed (e.g.
 * `.bashrc`). */
const splitFilePathExtension = (path: string): { stem: string; dotExt: string } => {
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const lastDot = path.lastIndexOf('.');
  if (lastDot <= lastSlash + 1) {
    // Either no dot at all, or the dot belongs to a hidden-file name.
    return { stem: path, dotExt: '' };
  }
  return { stem: path.slice(0, lastDot), dotExt: path.slice(lastDot) };
};

type Props = {
  download: Download;
  /** Open the password prompt for this row. App owns the modal state;
   * the row only signals "user wants to enter the password now". Used
   * to reopen a dismissed prompt without waiting for the next status
   * transition. */
  onOpenPasswordPrompt?: (id: string) => void;
  /** When true, surfaces a Transcribe button on completed rows. App
   * reads this off `Settings.transcriptionEnabled` so the user can
   * disable the button without un-saving their ElevenLabs key. */
  transcriptionEnabled?: boolean;
  /** When true (debug mode), the row shows a folder-icon button to
   * open its temp dir + a log box below the row body. Off by default. */
  debugMode?: boolean;
  /** Per-id log buffer, capped + appended by App. Only rendered when
   * debugMode is true. */
  debugLog?: readonly DebugLogEvent[];
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
  needs_cookies: 'Needs sign-in cookies',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  transcribing: 'Transcribing',
};

// Tailwind classes for the small status badge in the row header. Failed gets
// red so the row reads as broken at a glance even before the user reads the
// error message below. Canceling/cancelled stay neutral — both are the
// user's choice, not an error. Needs-{password, cookies} use amber to read as
// "action required" without claiming the row has actually failed.
const STATUS_BADGE_CLASS: Record<Download['status'], string> = {
  queued: 'text-neutral-700',
  downloading: 'text-neutral-700',
  canceling: 'text-neutral-700',
  needs_password: 'text-amber-800',
  needs_cookies: 'text-amber-800',
  completed: 'text-neutral-700',
  failed: 'text-red-700',
  cancelled: 'text-neutral-700',
  transcribing: 'text-neutral-700',
};

const formatPercent = (value: number): string =>
  Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';

const clampPercent = (value: number): number =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

export const DownloadRow = ({
  download,
  onOpenPasswordPrompt,
  transcriptionEnabled,
  debugMode,
  debugLog,
}: Props): React.JSX.Element => {
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
    <div className="flex gap-3 rounded-lg border border-neutral-200 bg-white p-4">
      {download.thumbnailUrl ? <Thumbnail url={download.thumbnailUrl} /> : null}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-medium text-neutral-900">{headerTitle}</div>
            {download.sourceSite ? (
              <SourceSiteBadge siteKey={download.sourceSite} url={download.url} />
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {debugMode ? <DebugTempFolderButton id={download.id} /> : null}
            {download.status === 'downloading' ? <CancelButton id={download.id} /> : null}
            {/* Transcribe button surfaces on completed rows when the
                user has opted into transcription (Settings toggle +
                ElevenLabs key saved — main bails the IPC with a
                useful error if either is missing). Hidden while
                transcription is in flight; the status text below
                takes over visually. Also build-time gated on
                ELEVENLABS_ENABLED so a stale `transcriptionEnabled:
                true` in a user's settings.json (from a previous
                build where the provider was enabled) can't surface
                the button in a disabled-feature build. */}
            {ELEVENLABS_ENABLED &&
            transcriptionEnabled &&
            download.status === 'completed' &&
            shouldShowTranscribeButton(download.transcriptionStatus) ? (
              <TranscribeButton id={download.id} />
            ) : null}
            <div className={`text-xs ${STATUS_BADGE_CLASS[download.status]}`}>
              {STATUS_LABEL[download.status]}
            </div>
          </div>
        </div>

        {download.status === 'downloading' || download.status === 'canceling' ? (
          <div className="mt-3 space-y-1.5">
            <div className="relative h-1.5 overflow-hidden rounded-full bg-neutral-200">
              {hasDeterminateProgress ? (
                <div
                  className="h-full bg-neutral-900 transition-all"
                  style={{ width: `${percent}%` }}
                />
              ) : (
                <div className="pluck-progress-indeterminate absolute inset-y-0 left-0 w-1/3 bg-neutral-900" />
              )}
            </div>
            {hasDeterminateProgress ? (
              <div className="flex justify-between text-xs text-neutral-700">
                <span>{formatPercent(download.progress)}</span>
                <span>
                  {download.speed ?? '—'} · ETA {download.eta ?? '—'}
                </span>
              </div>
            ) : (
              <div className="text-xs text-neutral-700">{startingLabel}</div>
            )}
          </div>
        ) : null}

        {download.status === 'completed' && download.filePath ? (
          <CompletedFooter filePath={download.filePath} transcriptPath={download.transcriptPath} />
        ) : null}

        {/* Transcription progress / error region. Renders only when
            the transcription pipeline is actively running or has
            ended in an error. The 'done' state shows nothing here —
            the SRT row in CompletedFooter is the affordance. */}
        {download.transcriptionStatus !== undefined &&
        download.transcriptionStatus.state !== 'idle' &&
        download.transcriptionStatus.state !== 'done' ? (
          <TranscriptionStatusRow status={download.transcriptionStatus} />
        ) : null}

        {/* needs_password footer: amber to read as "action required" rather
            than a failure. The auto-popped modal handles the happy path;
            this button reopens it if the user dismissed. */}
        {download.status === 'needs_password' && onOpenPasswordPrompt ? (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5">
            <span aria-hidden="true" className="select-none text-sm leading-none text-amber-800">
              🔒
            </span>
            <div className="min-w-0 flex-1 text-xs text-amber-800">
              This recording is password-protected.
            </div>
            <button
              type="button"
              onClick={() => onOpenPasswordPrompt(download.id)}
              className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100 focus:outline-none focus-visible:bg-amber-100"
            >
              Enter password
            </button>
          </div>
        ) : null}

        {/* needs_cookies footer: inline browser picker for the auth-
            required case (YouTube age gate, Twitter / X protected
            tweets, Instagram private, etc.). Picking a browser sets
            it as the global cookies-from-browser setting AND retries
            this row. The list filters to browsers actually present on
            this Mac via api.detectInstalledBrowsers. */}
        {download.status === 'needs_cookies' ? <NeedsCookiesRow id={download.id} /> : null}

        {/* Debug-only: per-row size + duration line for completed rows.
            Reads off Download.fileSizeBytes (captured at move time)
            and the createdAt → completedAt delta. */}
        {debugMode && download.status === 'completed' && download.completedAt ? (
          <DebugSizeDuration
            sizeBytes={download.fileSizeBytes}
            startMs={download.createdAt}
            endMs={download.completedAt}
          />
        ) : null}

        {/* Debug-only: monospace preview of the exact yt-dlp argv
            spawned for this row. Stamped on Download.invocationPreview
            at runOne time so it's stable for the lifetime of the row.
            Password values redacted by formatInvocationForDisplay. */}
        {debugMode && download.invocationPreview ? (
          <InvocationPreview text={download.invocationPreview} />
        ) : null}

        {/* Only render the log box when there's actually something to
            show. An empty box "Waiting for activity…" placeholder
            would just be visual noise on completed rows in history
            (no events ever fire for them post-load). */}
        {debugMode && debugLog && debugLog.length > 0 ? <LogBox lines={debugLog} /> : null}

        {/* Failed-state error block; always shown regardless of debug mode. */}
        {download.status === 'failed' && download.error ? (
          <div className="mt-3 flex gap-2 rounded-md border border-red-300 bg-red-50 p-2.5">
            <span aria-hidden="true" className="select-none text-sm leading-none text-red-700">
              ⚠
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-red-700">Download failed</div>
              <div className="mt-0.5 break-words text-xs text-red-700">{download.error}</div>
            </div>
            <RetryButton id={download.id} />
          </div>
        ) : null}
      </div>
    </div>
  );
};

// Shared classes for the thumbnail's visible box. h-12 w-20 keeps a 16:9
// aspect ratio at small size; bg-neutral-100 is the placeholder colour that
// shows while loading and again if the image fails. Pulled out so the <img>
// and its fallback placeholder can't drift apart.
const THUMBNAIL_BOX_CLASS = 'h-12 w-20 shrink-0 rounded bg-neutral-100';

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
      className="mt-0.5 inline-flex items-center gap-1.5 rounded text-xs text-neutral-700 transition hover:text-neutral-800 focus:outline-none focus-visible:text-neutral-800"
    >
      <SourceSiteIcon siteKey={siteKey} />
      <span>{siteKey}</span>
    </button>
  );
};

/** Folder-icon button visible only in debug mode. Click → opens the
 * per-download temp folder in Finder. Cheap log-box note (not a modal)
 * if the folder has already been cleaned (typical post-success case). */
const DebugTempFolderButton = ({ id }: { id: string }): React.JSX.Element => {
  const handleClick = (): void => {
    api.openTempFolder(id).catch((err: unknown) => {
      console.error('openTempFolder rejected:', err);
    });
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      title="Open temp folder (debug)"
      aria-label="Open temp folder"
      className="rounded p-1 text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-900"
    >
      <FolderIcon />
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
      className="shrink-0 self-start rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 transition hover:bg-red-100 hover:text-red-800 focus:outline-none focus-visible:bg-red-100"
    >
      Retry
    </button>
  );
};

/** Red cancel button shown next to the status badge while a download is
 * active. Click → api.cancelDownload(id); main process sends SIGTERM to
 * yt-dlp (then SIGKILL after 2 s), the row's status flips to 'cancelled',
 * and the temp workspace is wiped via the existing try/finally. */
/** True iff the row is in a state where we should surface the
 * Transcribe button. The button hides while the pipeline is
 * actively running (`extracting_audio` → `writing_srt`), shows
 * when it has never run (`undefined` or `idle`), and shows again
 * after a `done` or `error` terminal state so the user can re-run
 * if they want a fresh transcript. */
const shouldShowTranscribeButton = (status: Download['transcriptionStatus']): boolean => {
  if (status === undefined) {
    return true;
  }
  return status.state === 'idle' || status.state === 'done' || status.state === 'error';
};

/** Per-row Transcribe button. Click → main extracts audio, uploads
 * to ElevenLabs, writes a `.srt` next to the video. Progress flows
 * back via the existing onDownloadUpdate stream. Errors surface as
 * a red banner from `TranscriptionStatusRow`. */
const TranscribeButton = ({ id }: { id: string }): React.JSX.Element => {
  const handleTranscribe = (): void => {
    api.transcribeDownload(id).catch((err: unknown) => {
      console.error('transcribeDownload rejected:', err);
    });
  };
  return (
    <button
      type="button"
      onClick={handleTranscribe}
      title="Transcribe to .srt via ElevenLabs"
      aria-label="Transcribe to .srt via ElevenLabs"
      className="rounded-md border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700 transition hover:bg-sky-100 hover:text-sky-800 focus:outline-none focus-visible:bg-sky-100"
    >
      Transcribe
    </button>
  );
};

/** Human copy + progress styling for each transcription pipeline
 * stage. Pulled into a const so the renderer never branches on the
 * full TranscriptionStatus discriminant inline. */
const TRANSCRIPTION_LABEL: Record<
  Exclude<NonNullable<Download['transcriptionStatus']>['state'], 'idle' | 'done'>,
  string
> = {
  extracting_audio: 'Extracting audio…',
  uploading: 'Uploading to ElevenLabs…',
  transcribing: 'Transcribing…',
  writing_srt: 'Writing .srt…',
  error: 'Transcription failed.',
};

/** Compact status banner below the row body during transcription.
 * Shows an indeterminate sliding bar for the in-flight stages
 * (extracting → writing), and a red error message when the
 * pipeline lands on `error`. The `done` state doesn't render here
 * — the SRT row in `CompletedFooter` takes over as the affordance. */
const TranscriptionStatusRow = ({
  status,
}: {
  status: NonNullable<Download['transcriptionStatus']>;
}): React.JSX.Element | null => {
  if (status.state === 'idle' || status.state === 'done') {
    return null;
  }
  if (status.state === 'error') {
    return (
      <div className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
        <span className="font-medium">Transcription failed.</span>{' '}
        <span className="text-red-700 break-words">{status.message}</span>
      </div>
    );
  }
  return (
    <div className="mt-3 space-y-1.5">
      <div className="relative h-1 overflow-hidden rounded-full bg-neutral-200">
        <div className="pluck-progress-indeterminate absolute inset-y-0 left-0 w-1/3 bg-sky-600" />
      </div>
      <div className="text-xs text-neutral-700">{TRANSCRIPTION_LABEL[status.state]}</div>
    </div>
  );
};

/** Inline browser picker shown beneath a row whose status is
 * 'needs_cookies'. Asks main which browsers have cookies on this Mac
 * via api.detectInstalledBrowsers, renders one button per browser,
 * dispatches submitCookiesBrowser on click. The IPC handler persists
 * the choice globally AND flips this row back to 'queued'.
 *
 * Empty installed list is rare (would mean no supported browser on
 * the Mac) but possible — we fall back to showing every BROWSER_NAMES
 * entry so the user still has an actionable surface; if a guessed
 * browser turns out to have no cookies, the next attempt fails with
 * YtDlpCookieAccessDeniedError which surfaces its own friendly
 * message. */
const NeedsCookiesRow = ({ id }: { id: string }): React.JSX.Element => {
  const [installed, setInstalled] = useState<readonly BrowserName[] | undefined>(undefined);
  const [submitting, setSubmitting] = useState<BrowserName | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .detectInstalledBrowsers()
      .then((browsers) => {
        if (!cancelled) {
          setInstalled(browsers);
        }
      })
      .catch((err: unknown) => {
        console.error('detectInstalledBrowsers rejected:', err);
        // Leave `installed` undefined — the render branch below shows
        // a quiet message rather than guessing.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePick = (browser: BrowserName): void => {
    setSubmitting(browser);
    api.submitCookiesBrowser(id, browser).catch((err: unknown) => {
      console.error('submitCookiesBrowser rejected:', err);
      setSubmitting(undefined);
    });
  };

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="select-none text-sm leading-none text-amber-800">
          🔐
        </span>
        <div className="min-w-0 flex-1 text-xs text-amber-800">
          This content requires sign-in cookies. Pick a browser whose session is signed in to the
          source site (and age-verified, if applicable).
        </div>
      </div>
      {installed === undefined ? (
        <div className="text-xs text-amber-800">Loading available browsers…</div>
      ) : installed.length === 0 ? (
        <div className="text-xs text-amber-800">
          No supported browsers detected on this Mac. Open Chrome, Firefox, Safari, Brave, or Edge,
          sign in to the source site, and retry.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {installed.map((browser) => (
            <button
              key={browser}
              type="button"
              onClick={() => handlePick(browser)}
              disabled={submitting !== undefined}
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 transition hover:bg-amber-100 focus:outline-none focus-visible:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting === browser
                ? `Using ${BROWSER_DISPLAY[browser]}…`
                : BROWSER_DISPLAY[browser]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

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
      className="rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 transition hover:bg-red-100 hover:text-red-800 focus:outline-none focus-visible:bg-red-100"
    >
      Cancel
    </button>
  );
};

/** Saved-to line plus a folder-icon button that reveals the file in Finder.
 * Extracted so the narrowed `filePath: string` (vs the parent's optional)
 * stays clean inside the button's click handler. The button is disabled
 * with an explanatory tooltip when the file is missing from disk — the
 * user moved it via Finder, sent it to the Trash, or otherwise deleted
 * it out of band. Existence is rechecked on window focus so coming back
 * from a Finder cleanup session picks up the new state without a
 * re-render. */
const CompletedFooter = ({
  filePath,
  transcriptPath,
}: {
  filePath: string;
  transcriptPath?: string;
}): React.JSX.Element => {
  // undefined = haven't checked yet (treat as present until proven
  // otherwise so the button doesn't flicker disabled on every render).
  const [exists, setExists] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      api
        .fileExists(filePath)
        .then((value) => {
          if (!cancelled) {
            setExists(value);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setExists(false);
          }
        });
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
    };
  }, [filePath]);

  const handleReveal = (): void => {
    api.showInFinder(filePath).catch((err: unknown) => {
      console.error('showInFinder rejected:', err);
    });
  };

  const isMissing = exists === false;
  const { stem, dotExt } = splitFilePathExtension(filePath);

  return (
    <div className="mt-2 flex items-start gap-2">
      <div
        className={`min-w-0 flex-1 break-words text-xs ${isMissing ? 'text-neutral-700 line-through' : 'text-emerald-700'}`}
      >
        Saved to {stem}
        {dotExt ? <span className={isMissing ? '' : 'text-sky-700'}>{dotExt}</span> : null}
      </div>
      <button
        type="button"
        onClick={handleReveal}
        disabled={isMissing}
        title={isMissing ? MISSING_FILE_TOOLTIP : 'Show in Finder'}
        aria-label={isMissing ? MISSING_FILE_TOOLTIP : 'Show in Finder'}
        className="shrink-0 rounded p-1 text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:text-neutral-400 disabled:hover:bg-transparent disabled:hover:text-neutral-400"
      >
        <FolderIcon />
      </button>
      {transcriptPath ? <SrtRow transcriptPath={transcriptPath} /> : null}
    </div>
  );
};

/** Secondary "Saved transcript" line that renders below the main
 * file row when transcription has produced an SRT next to the
 * video. Same visual pattern as the file row — basename text +
 * folder-icon reveal button — plus an `SRT` chip so the line
 * reads as a related-but-distinct artifact. */
const SrtRow = ({ transcriptPath }: { transcriptPath: string }): React.JSX.Element => {
  const handleReveal = (): void => {
    api.showInFinder(transcriptPath).catch((err: unknown) => {
      console.error('showInFinder rejected:', err);
    });
  };
  const filename = transcriptPath.split('/').pop() ?? transcriptPath;
  return (
    <div className="mt-2 flex w-full items-center gap-2">
      <span className="shrink-0 rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-neutral-800">
        SRT
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-neutral-700">{filename}</span>
      <button
        type="button"
        onClick={handleReveal}
        title="Show transcript in Finder"
        aria-label="Show transcript in Finder"
        className="shrink-0 rounded p-1 text-neutral-700 transition hover:bg-neutral-100 hover:text-neutral-900"
      >
        <FolderIcon />
      </button>
    </div>
  );
};

/** Debug-only line below a completed row: `1.2 GB · 3m 12s`. Size is
 * omitted when stat couldn't capture it; both pieces share a center
 * dot so the line reads cleanly even if one half is missing. */
const DebugSizeDuration = ({
  sizeBytes,
  startMs,
  endMs,
}: {
  sizeBytes: number | undefined;
  startMs: number;
  endMs: number;
}): React.JSX.Element => {
  const parts: string[] = [];
  if (sizeBytes !== undefined) {
    parts.push(formatBytes(sizeBytes));
  }
  parts.push(formatDuration(endMs - startMs));
  return <div className="mt-2 text-xs text-neutral-700">{parts.join(' · ')}</div>;
};

/** Debug-only monospace block: the exact yt-dlp argv this row used.
 * `<pre>` preserves wrapping intent; `whitespace-pre-wrap` lets a
 * long command break across lines without horizontal scrolling. The
 * block is selectable, so the user can copy and paste into Terminal. */
const InvocationPreview = ({ text }: { text: string }): React.JSX.Element => (
  <pre className="mt-2 whitespace-pre-wrap break-all rounded-md border border-neutral-200 bg-white p-2 font-mono text-[11px] leading-snug text-neutral-700">
    {text}
  </pre>
);

/** Compact byte formatter — `1.2 GB`, `847 MB`, `512 KB`, `64 B`. Uses
 * 1024-based units (binary) since macOS Finder is finally using SI
 * (1000-based) but most engineers still expect 1024. Pick one and be
 * consistent; mixing causes "why is the file's size different from
 * what I see in Finder?" confusion either way. */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  // 1 decimal place under 100, 0 above — matches Finder-ish rounding.
  const formatted = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unitIdx]}`;
};

/** Compact duration formatter — `3m 12s`, `47s`, `1h 5m`. Stops at
 * hours; downloads longer than a day are surely some debug pathology
 * we'd want to know about anyway. */
const formatDuration = (deltaMs: number): string => {
  const totalSec = Math.max(0, Math.floor(deltaMs / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
};
