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
