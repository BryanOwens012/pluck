import {
  PLAYLIST_ENTRY_CAP,
  type PlaylistContext,
  type PlaylistOrder,
} from '../../../shared/types';

type Props = {
  /** Playlist info to render in the modal subtitle (title + count).
   * Undefined when the user clicked Download before the metadata
   * probe returned but the URL syntactically looks like a playlist
   * (has `list=` or ends in `/playlist`) — we still pop the modal so
   * the user gets to choose, and fill in the title/count from the
   * enumerate pass if they pick "All videos". */
  context: PlaylistContext | undefined;
  /** Called when the user clicks "Just this video" (or hits Esc /
   * backdrop). On an explicit playlist URL this becomes "Just the
   * first video" and the caller is expected to honor that intent. */
  onJustOne: () => void;
  /** Called when the user picks one of the whole-playlist buttons.
   * The `order` argument tells the caller whether to enqueue in
   * playlist order (oldest_first) or reversed (newest_first). */
  onWholePlaylist: (order: PlaylistOrder) => void;
};

/** Modal that appears when the user clicks Download on a URL whose
 * resolved metadata carries a playlist context. Three choices:
 *
 *   1. Just this video / Just the first video — single download,
 *      yt-dlp gets `--no-playlist`.
 *   2. All videos (oldest → newest) — enumerate the playlist and
 *      enqueue every entry in playlist order.
 *   3. All videos (newest → oldest) — same, reversed.
 *
 * Esc + backdrop click both default to "just this video" (the safer
 * option — don't accidentally enqueue 50 downloads). */
export const PlaylistPrompt = ({
  context,
  onJustOne,
  onWholePlaylist,
}: Props): React.JSX.Element => {
  // When context is undefined (probe still in flight), we don't yet
  // know whether the URL is an explicit playlist URL or a video URL
  // that happens to carry playlist context. "Just this video" is the
  // safe default copy — the IPC handler honors `--no-playlist` in
  // both shapes, so it's accurate either way.
  const justOneLabel = context?.isExplicitPlaylistUrl ? 'Just the first video' : 'Just this video';
  const subtitle = context
    ? context.entryCount !== undefined
      ? `${context.title} (${context.entryCount} videos)`
      : context.title
    : 'Fetching playlist details…';
  const overCap = context?.entryCount !== undefined && context.entryCount > PLAYLIST_ENTRY_CAP;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="playlist-prompt-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/50 p-4"
      onClick={(event) => {
        // Backdrop click dismisses; clicks on the inner card land on a
        // descendant so event.target !== currentTarget.
        if (event.target === event.currentTarget) {
          onJustOne();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onJustOne();
        }
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 shadow-xl">
        <h2 id="playlist-prompt-title" className="text-sm font-semibold text-neutral-900">
          This video is part of a playlist.
        </h2>
        <p className="mt-1 break-words text-xs text-neutral-700">{subtitle}</p>
        {overCap && context ? (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
            This playlist has {context.entryCount} videos. Pluck will queue the first{' '}
            {PLAYLIST_ENTRY_CAP}.
          </p>
        ) : null}
        <div className="mt-4 space-y-2">
          <button
            // Autofocus this button so Esc fires the div-level keydown
            // handler immediately (the dialog needs focus inside it
            // for Esc to dispatch). Also gives keyboard users a
            // sensible default action.
            // biome-ignore lint/a11y/noAutofocus: modal entry-point focus
            autoFocus
            type="button"
            onClick={onJustOne}
            className="w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          >
            {justOneLabel}
          </button>
          <button
            type="button"
            onClick={() => onWholePlaylist('oldest_first')}
            className="w-full rounded-md border border-neutral-300 bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          >
            All videos in the playlist (oldest to newest)
          </button>
          <button
            type="button"
            onClick={() => onWholePlaylist('newest_first')}
            className="w-full rounded-md border border-neutral-300 bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          >
            All videos in the playlist (newest to oldest)
          </button>
        </div>
      </div>
    </div>
  );
};
