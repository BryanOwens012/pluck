/** Language patterns passed to yt-dlp's `--sub-langs` flag. Each entry
 * uses yt-dlp's pattern grammar (`en.*` glob, `en-orig` literal). */

/** Always-on set: manual + auto-generated English. `en.*` matches `en`,
 * `en-US`, `en-GB`, etc.; `en-orig` is yt-dlp's synthetic code for the
 * auto-generated transcript in the source's original language tag
 * (often the only "auto-subs" entry that actually exists when manual
 * `en` subs also do). At most 2-3 sub files per video — light enough
 * to clear YouTube's anonymous rate limit when spaced by
 * `--sleep-subtitles`. */
export const SUBTITLE_LANGS_DEFAULT = ['en.*', 'en-orig'].join(',');

/** Extended set — only emitted when the user has browser cookies set
 * (authenticated requests have a much higher per-IP rate limit, so
 * 4 langs × 2-3 variants each is safe). Codes follow yt-dlp's names:
 * `zh.*` covers `zh-Hans` / `zh-Hant` / `zh-CN` / `zh-TW`; `pt.*`
 * would cover `pt-BR`. Unknown codes on non-YouTube sources are
 * silently ignored. */
export const SUBTITLE_LANGS_EXTENDED = [
  'en.*',
  'en-orig',
  'zh.*', // Chinese (Simplified + Traditional + regional variants)
  'es.*', // Spanish
  'fr.*', // French
].join(',');
