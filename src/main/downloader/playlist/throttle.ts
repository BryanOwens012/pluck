import type { Download } from '../../../shared/types';

/** Per-row `-N` cap when a Download row is part of a playlist enqueue.
 * Multiple playlist rows in flight at once × the user's default -N
 * (14) trips YouTube's per-IP rate limit fast — at 3 concurrent rows
 * that's 42 simultaneous fragment connections, well above the
 * threshold for 429 responses. Capping at 2 fragments per row keeps
 * the total under a dozen even at the max concurrent-rows setting,
 * with a modest single-video slowdown but no rate-limit storms.
 * Single-video downloads (no playlistId) keep the user's setting. */
const PLAYLIST_ROW_CONCURRENT_FRAGMENTS = 2;

/** Seconds yt-dlp sleeps between extractor requests for playlist
 * rows (passed through `--sleep-requests`). Smooths the burst of
 * metadata fetches that comes from N rows pre-fetching at once. */
const PLAYLIST_ROW_REQUEST_SLEEP_SECONDS = 1;

/** Max playlist rows allowed to run concurrently. Set to 1 (serial)
 * because YouTube's per-IP request limit applies across processes —
 * two parallel playlist rows means double the connection count of
 * `PLAYLIST_ROW_CONCURRENT_FRAGMENTS` plus double the extractor
 * request rate, which trips 429 even with `--sleep-requests` spacing.
 * Non-playlist (single-video) rows keep the user's normal global
 * concurrency cap; only playlist-row picks are throttled. */
export const PLAYLIST_ROW_CONCURRENT_DOWNLOADS = 1;

/** Per-download throttle decision returned by `resolvePlaylistThrottle`.
 * The queue reads `isPlaylistRow` to gate promotions against
 * `PLAYLIST_ROW_CONCURRENT_DOWNLOADS`, and the args builder reads the
 * two override fields to pin `-N` and `--sleep-requests` for playlist
 * rows only. Both override fields are undefined for non-playlist
 * rows; the args builder falls through to the user's settings. */
export type PlaylistThrottle = {
  isPlaylistRow: boolean;
  concurrentFragments?: number;
  requestSleepSeconds?: number;
};

/** Pure function — keyed entirely off `download.playlistId`. Living
 * in its own module keeps the throttle policy in one place; the
 * queue + args builder both call it instead of branching on
 * `playlistId` themselves. */
export const resolvePlaylistThrottle = (download: Download): PlaylistThrottle => {
  if (download.playlistId === undefined) {
    return { isPlaylistRow: false };
  }
  return {
    isPlaylistRow: true,
    concurrentFragments: PLAYLIST_ROW_CONCURRENT_FRAGMENTS,
    requestSleepSeconds: PLAYLIST_ROW_REQUEST_SLEEP_SECONDS,
  };
};
