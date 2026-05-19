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

/** Cheap sync pre-check for "this URL is probably a playlist". Used by
 * the renderer's submit handler so the PlaylistPrompt modal opens even
 * when the user clicks Download before the async metadata probe has
 * returned. The probe ultimately delivers the authoritative
 * playlistContext, but we can't make the user wait on it just to know
 * whether to ask the question. Matches:
 *   - `youtube.com/watch?v=X&list=Y[...]` — video URL carrying playlist
 *   - `youtube.com/playlist?list=Y` — explicit playlist URL
 *   - `youtube.com/.../playlist` paths (legacy / channel playlist URLs)
 * False for plain video URLs and anything that doesn't parse as a URL. */
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
