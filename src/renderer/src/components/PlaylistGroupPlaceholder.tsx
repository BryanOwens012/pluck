import type { PlaylistContext } from '../../../shared/types';

type Props = {
  /** Playlist info from the format-probe pass when present — lets
   * the placeholder show the real title + count while enumerate is
   * in flight. Undefined when the user clicked Download before the
   * probe returned; the placeholder falls back to generic copy. */
  context: PlaylistContext | undefined;
  /** When set, the placeholder switches into an error state instead
   * of the loading state — red border, error icon, the message, and
   * a Dismiss button. Set by App.tsx when `enumeratePlaylist` fails
   * (network down, bad URL, empty playlist) so the placeholder
   * doesn't silently vanish; the user sees what went wrong and gets
   * to clear it. Undefined means "still loading". */
  error?: string;
  /** Invoked when the user clicks the Dismiss button in the error
   * state. App.tsx uses this to remove the entry from
   * `pendingEnumerations`. Optional so the loading-state code path
   * doesn't need to pass it. */
  onDismiss?: () => void;
};

/** Stand-in accordion shell rendered the moment the user picks "All
 * videos" in the PlaylistPrompt modal, BEFORE the
 * `enumeratePlaylist` IPC (yt-dlp -J --flat-playlist, typically
 * 5-10 s) returns. Without this the queue is blank for the duration
 * of the enumerate, which reads as "click did nothing" even though
 * the spawn is in flight.
 *
 * Visually mirrors `PlaylistGroup`'s expanded shell — same border,
 * padding, header layout, progress-bar slot — so the swap from
 * placeholder to real group when rows arrive is a content change
 * instead of a layout shift. Differences from the real group:
 *
 *   - No chevron / expand-collapse: there's no body to hide yet.
 *   - No Cancel-all: enumerate can't be cancelled from this side
 *     (no IPC abort surface for the running yt-dlp -J).
 *   - Progress bar is the indeterminate slide (`pluck-progress-
 *     indeterminate`), same as a fresh per-row download.
 *
 * Has two visual modes:
 *
 *   - **Loading** (default, `error` undefined): spinner + title +
 *     "fetching N videos…" subtitle + indeterminate bar.
 *   - **Error** (`error` set): red border + error icon + the
 *     message + Dismiss button. Stays until the user dismisses so
 *     they get to read the message — silent vanish read as "click
 *     did nothing" the FIRST time around (the reason this whole
 *     placeholder exists).
 *
 * On the success path, App.tsx removes the entry from
 * `pendingEnumerations` once `startPlaylistDownload` resolves and
 * the real rows have shown up in the queue. */
export const PlaylistGroupPlaceholder = ({
  context,
  error,
  onDismiss,
}: Props): React.JSX.Element => {
  if (error !== undefined) {
    return <ErrorState context={context} error={error} onDismiss={onDismiss} />;
  }
  return <LoadingState context={context} />;
};

const LoadingState = ({ context }: { context: PlaylistContext | undefined }): React.JSX.Element => {
  const title = context?.title ?? 'Loading playlist…';
  const subtitle =
    context?.entryCount !== undefined
      ? `fetching ${context.entryCount} videos…`
      : 'fetching playlist…';

  return (
    <section
      aria-live="polite"
      aria-busy="true"
      className="rounded-lg border border-neutral-200 bg-neutral-100/40 p-3"
    >
      <header className="flex items-center gap-2">
        <Spinner />
        <h3 className="min-w-0 flex-1 break-words text-xs font-semibold text-neutral-800">
          {title}
        </h3>
        <span className="shrink-0 text-xs italic text-neutral-700">{subtitle}</span>
      </header>
      <div className="mt-2 flex items-center gap-2">
        <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-neutral-200">
          <div className="pluck-progress-indeterminate absolute inset-y-0 left-0 w-1/3 bg-neutral-900" />
        </div>
      </div>
    </section>
  );
};

const ErrorState = ({
  context,
  error,
  onDismiss,
}: {
  context: PlaylistContext | undefined;
  error: string;
  onDismiss: (() => void) | undefined;
}): React.JSX.Element => {
  const title = context?.title ?? 'Playlist';

  return (
    <section role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3">
      <header className="flex items-center gap-2">
        <ErrorIcon />
        <h3 className="min-w-0 flex-1 break-words text-xs font-semibold text-red-800">{title}</h3>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss playlist error"
            className="shrink-0 rounded-md border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 transition hover:bg-red-100 hover:text-red-800 focus:outline-none focus-visible:bg-red-100"
          >
            Dismiss
          </button>
        ) : null}
      </header>
      <p className="mt-2 break-words text-xs text-red-700">{error}</p>
    </section>
  );
};

/** Inline-SVG spinner. Matches the chevron's 12px size + neutral-500
 * tint so the placeholder header visually slots in at the same
 * column position the real accordion's chevron occupies. */
const Spinner = (): React.JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
    className="h-3 w-3 shrink-0 animate-spin text-neutral-700"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

/** Inline-SVG error triangle. Same 12px footprint as the spinner so
 * the loading→error transition doesn't shift the header layout. */
const ErrorIcon = (): React.JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="h-3 w-3 shrink-0 text-red-700"
  >
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);
