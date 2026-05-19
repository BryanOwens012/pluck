import type { PlaylistContext } from '../../../shared/types';

type Props = {
  /** Playlist info from the format-probe pass when present — lets
   * the placeholder show the real title + count while enumerate is
   * in flight. Undefined when the user clicked Download before the
   * probe returned; the placeholder falls back to generic copy. */
  context: PlaylistContext | undefined;
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
 * Lives until App.tsx removes it from `pendingEnumerations` — either
 * when `startPlaylistDownload` completes (the real rows have just
 * landed in the queue) or when enumerate fails (caller logs +
 * removes so the placeholder doesn't get orphaned). */
export const PlaylistGroupPlaceholder = ({ context }: Props): React.JSX.Element => {
  const title = context?.title ?? 'Loading playlist…';
  const subtitle =
    context?.entryCount !== undefined
      ? `fetching ${context.entryCount} videos…`
      : 'fetching playlist…';

  return (
    <section
      aria-live="polite"
      aria-busy="true"
      className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3"
    >
      <header className="flex items-center gap-2">
        <Spinner />
        <h3 className="min-w-0 flex-1 break-words text-xs font-semibold text-neutral-300">
          {title}
        </h3>
        <span className="shrink-0 text-xs italic text-neutral-500">{subtitle}</span>
      </header>
      <div className="mt-2 flex items-center gap-2">
        <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-neutral-800">
          <div className="pluck-progress-indeterminate absolute inset-y-0 left-0 w-1/3 bg-neutral-100" />
        </div>
      </div>
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
    className="h-3 w-3 shrink-0 animate-spin text-neutral-500"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);
