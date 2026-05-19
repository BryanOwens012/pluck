/**
 * Shared URL helpers. Pure functions; safe to import from both the main and
 * renderer processes.
 */

/** Type-guard: true when `value` is a string and looks like an http or https
 * URL. Used as a defensive gate before invoking yt-dlp or shell.openExternal,
 * so a compromised renderer (or just a typo in a future IPC call) can't pass
 * `file://`, `javascript:`, or arbitrary garbage through. */
export const isHttpUrl = (value: unknown): value is string => {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
};

/** Cheap pre-check for "this URL might be a playlist". Inspects only the
 * URL shape — no network. Used by the renderer to decide whether to even
 * bother running the playlist-aware prompt path; the authoritative signal
 * is the `playlistContext` field on the metadata fetch result. */
export const looksLikePlaylistUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.searchParams.has('list')) {
    return true;
  }
  if (/\/playlist$/.test(parsed.pathname)) {
    return true;
  }
  return false;
};
