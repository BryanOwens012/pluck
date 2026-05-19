/** Shared URL helpers. Pure functions; safe to import from both the main and
 * renderer processes. Each helper lives in its own file; callers can either
 * import from this barrel or from the specific file. */
export { isHttpUrl } from './is-http';
export { looksLikePlaylistUrl } from './looks-like-playlist';
