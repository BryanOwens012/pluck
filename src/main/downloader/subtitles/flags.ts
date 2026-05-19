import { SUBTITLE_LANGS_DEFAULT, SUBTITLE_LANGS_EXTENDED } from './langs';

/** Sub-download flags emitted on EVERY download — manual + auto-
 * generated English only. The user expects at least English subs on
 * every video regardless of whether they've set cookies, and 1 lang
 * × ≤3 variants spaced by `--sleep-subtitles` clears YouTube's
 * anonymous rate limit reliably. */
export const SUBTITLE_DOWNLOAD_FLAGS_DEFAULT = [
  '--embed-subs',
  '--write-auto-subs',
  '--sub-langs',
  SUBTITLE_LANGS_DEFAULT,
] as const;

/** Sub-download flags emitted ONLY when the user has browser cookies
 * set — extends the language list to en/zh/es/fr. Authenticated
 * requests have a much higher rate limit, so the wider pull doesn't
 * trip 429s. */
export const SUBTITLE_DOWNLOAD_FLAGS_EXTENDED = [
  '--embed-subs',
  '--write-auto-subs',
  '--sub-langs',
  SUBTITLE_LANGS_EXTENDED,
] as const;

/** Returns the right sub-flag tuple for a download based on whether
 * cookies are configured. Resolver lives here so the args-single
 * builder doesn't need to know about the two constants by name. */
export const resolveSubtitleFlags = (opts: { cookiesFromBrowser?: string }): readonly string[] => {
  return opts.cookiesFromBrowser
    ? SUBTITLE_DOWNLOAD_FLAGS_EXTENDED
    : SUBTITLE_DOWNLOAD_FLAGS_DEFAULT;
};
