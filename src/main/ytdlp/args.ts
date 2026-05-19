import { join } from 'node:path';
import {
  BROWSER_NAMES,
  type BrowserName,
  type ExtractedFlags,
  SUBTITLE_DOWNLOAD_FLAGS,
} from '../../shared/types';
import type { FetchMetadataOptions, RunDownloadOptions, RunnerDeps } from './types';

/** Default for yt-dlp `-N` (parallel HTTP connections per single
 * download) when the caller doesn't specify. yt-dlp's own default is 1
 * (serial); 14 saturates most home connections without enough per-
 * server load to trip rate limits on the sites we target (YouTube,
 * Vimeo, Zoom). The user can override this per-app via Settings →
 * Developer → Concurrent fragments (1-20). */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 14;

/** yt-dlp's `-J` JSON metadata output can be large (extractor fields,
 * full `formats` array). 100 MB is well above what we'd ever see for
 * a single video and below Node's default JSON parser ceiling. */
export const METADATA_MAX_BUFFER = 100 * 1024 * 1024;

/** Max stderr lines retained for the close-handler's error parsing.
 * yt-dlp can emit hundreds of lines on a broken extractor; we only
 * need the recent ones to diagnose. Older lines drop off the front. */
export const MAX_STDERR_RETENTION_LINES = 256;

/** SIGTERM → SIGKILL grace period on cancellation. Lets yt-dlp wind
 * down its child ffmpeg before we force-kill. 2 s matches the macOS
 * `kill` man page recommendation for non-essential daemons. */
export const CANCEL_FORCE_KILL_AFTER_MS = 2000;

/** yt-dlp `--progress-template` JSON shape. Emitted on stdout once per
 * progress tick, parsed by parser.ts. yt-dlp writes both its info
 * chatter and this template to stdout (despite the conventional split);
 * parseProgressLine returns null for non-JSON noise lines. */
const PROGRESS_TEMPLATE = [
  '{',
  '"status":"%(progress.status)s",',
  '"percent":"%(progress._percent_str)s",',
  '"speed":"%(progress._speed_str)s",',
  '"eta":"%(progress._eta_str)s"',
  '}',
].join('');

/** yt-dlp writes the final post-move filepath here via `--print-to-file`.
 * We can't use plain `--print` because it activates implicit quiet mode
 * and silences both the info chatter and the `--progress-template`
 * output. The marker file lives inside the per-download tempFolder so
 * removeTempFolder() reaps it automatically. The leading "." keeps it
 * out of Finder by default. */
export const FINAL_PATH_MARKER_FILENAME = '.pluck-final-path';

// Format args live on FormatChoice in shared/types.ts (STATIC_FORMAT_CHOICES
// for the four default presets; format-selector.ts builds per-URL choices
// including the optional 5th non-mp4 alternative). buildDownloadArgs
// receives the already-built args as opts.ytDlpFormatArgs and spreads them
// straight into argv — runner stays oblivious to format semantics.

/** Token used inside a yt-dlp override string to mark where the URL
 * should be substituted. When absent from the user's override, the URL
 * is appended at the end of argv (yt-dlp's usual positional spot). */
export const URL_PLACEHOLDER_TOKEN = '<URL>';

export type ParseResult = { ok: true; argv: string[] } | { ok: false; error: string };

/** Tokenize a user-supplied yt-dlp command string into argv. Designed
 * to feel familiar to anyone who's typed a shell command, with two
 * deliberate departures from a real shell:
 *
 *   - **No expansion of any kind.** `$VAR`, `$(cmd)`, backtick `, glob
 *     `*` / `?`, brace `{a,b}` and history `!` are all left as plain
 *     characters. A user typing `&& rm -rf /` gets four inert tokens;
 *     a URL like `https://x.com/$(touch /tmp/PWN)` lands as data.
 *   - **The first token must be `yt-dlp`** so the override can't aim
 *     at a different binary.
 *
 * Single quotes preserve their contents verbatim. Double quotes allow
 * a small backslash-escape set (`"`, `\\`, `$`, `` ` ``, newline for
 * line continuation) and otherwise pass through. Unquoted backslash
 * escapes any next character, with `\\<newline>` treated as line
 * continuation. Whitespace splits tokens.
 *
 * Returned argv has the leading `yt-dlp` already stripped — callers
 * spread it directly into the rest of the spawn argv. */
export const parseYtDlpCommand = (input: string): ParseResult => {
  const tokens: string[] = [];
  let current = '';
  let hasTokenInProgress = false;
  let inSingle = false;
  let inDouble = false;

  const finalizeToken = (): void => {
    if (hasTokenInProgress) {
      tokens.push(current);
      current = '';
      hasTokenInProgress = false;
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (inSingle) {
      if (c === "'") {
        inSingle = false;
      } else {
        current += c;
        hasTokenInProgress = true;
      }
      continue;
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false;
        continue;
      }
      if (c === '\\') {
        const next = input[i + 1];
        if (next === undefined) {
          return { ok: false, error: 'Trailing backslash inside double-quoted string.' };
        }
        // Inside double quotes only a small set is escaped; anything
        // else leaves the backslash literal.
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
        } else if (next === '\n') {
          // Line continuation inside double quotes — drop both bytes.
        } else {
          current += '\\';
          current += next;
        }
        i += 1;
        hasTokenInProgress = true;
        continue;
      }
      current += c;
      hasTokenInProgress = true;
      continue;
    }
    // Unquoted.
    if (c === "'") {
      inSingle = true;
      hasTokenInProgress = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      hasTokenInProgress = true;
      continue;
    }
    if (c === '\\') {
      const next = input[i + 1];
      if (next === undefined) {
        return { ok: false, error: 'Trailing backslash.' };
      }
      if (next === '\n') {
        // Line continuation — eat both bytes.
      } else {
        current += next;
        hasTokenInProgress = true;
      }
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      finalizeToken();
      continue;
    }
    current += c;
    hasTokenInProgress = true;
  }

  if (inSingle) {
    return { ok: false, error: 'Unterminated single quote.' };
  }
  if (inDouble) {
    return { ok: false, error: 'Unterminated double quote.' };
  }
  finalizeToken();

  if (tokens.length === 0) {
    return { ok: false, error: 'Override is empty.' };
  }
  const head = tokens[0];
  if (head !== 'yt-dlp') {
    return { ok: false, error: `First token must be \`yt-dlp\` (got \`${head}\`).` };
  }
  return { ok: true, argv: tokens.slice(1) };
};

/** Best-effort scan of an override's parsed argv for the flags whose
 * values mirror into the Settings UI (so the dependent dropdowns can
 * gray out + show the user what the override decoded to). Unknown
 * flags are ignored — the override still controls what runs; this
 * just keeps the informational dropdowns in sync. */
export const extractKnownFlags = (argv: readonly string[]): ExtractedFlags => {
  const result: ExtractedFlags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '-N' && value !== undefined) {
      const n = Number.parseInt(value, 10);
      if (Number.isInteger(n) && n > 0) {
        result.concurrentFragments = n;
      }
      i += 1;
      continue;
    }
    if (flag === '--cookies-from-browser' && value !== undefined) {
      if ((BROWSER_NAMES as readonly string[]).includes(value)) {
        result.cookiesFromBrowser = value as BrowserName;
      }
      i += 1;
      continue;
    }
    if ((flag === '-f' || flag === '--format') && value !== undefined) {
      result.format = value;
      i += 1;
      continue;
    }
    if ((flag === '-o' || flag === '--output') && value !== undefined) {
      result.outputTemplate = value;
      i += 1;
    }
  }
  return result;
};

/** Names of flags whose value is sensitive and must not appear in any
 * UI surface (per-row preview, copy buffers, debug logs). The actual
 * spawn still uses the real value — this redaction only affects what
 * the user sees on screen. */
const REDACTED_VALUE_FLAGS = new Set(['--video-password']);

/** Characters that force single-quote wrapping when an arg is rendered
 * for display. Includes the obvious shell metacharacters so a copy-
 * paste from the per-row preview into Terminal works the same way it
 * looks. */
const NEEDS_QUOTING_PATTERN = /[\s"'$`\\<>|&;*?(){}[\]!#~]/;

/** Join an argv array into a single shell-safe display string. Args
 * containing whitespace or shell metacharacters are wrapped in single
 * quotes (with any embedded single quotes escaped via `'\''`); values
 * for password-style flags are replaced with `'***'` regardless of
 * their actual content. The leading `yt-dlp` is prepended so the
 * rendered line reads as a complete command. */
export const formatInvocationForDisplay = (argv: readonly string[]): string => {
  const parts: string[] = ['yt-dlp'];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? '';
    parts.push(quoteForDisplay(token));
    if (REDACTED_VALUE_FLAGS.has(token) && i + 1 < argv.length) {
      parts.push("'***'");
      i += 1;
    }
  }
  return parts.join(' ');
};

const quoteForDisplay = (token: string): string => {
  if (token.length === 0) {
    return "''";
  }
  if (!NEEDS_QUOTING_PATTERN.test(token)) {
    return token;
  }
  // Single-quote wrap. Embedded single quotes get the classic shell
  // dance: close the quoted string, emit a backslash-escaped quote,
  // reopen — i.e. `'\''`.
  return `'${token.replace(/'/g, `'\\''`)}'`;
};

/** Build the argv for `yt-dlp -J --no-download <url>` (metadata fetch).
 * Pure function — no side effects, no spawn. Runner consumes the
 * returned array directly. */
export const buildMetadataArgs = (url: string, options: FetchMetadataOptions): string[] => {
  const args = ['-J', '--no-download'];
  if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  }
  args.push(url);
  return args;
};

/** Build the argv for `yt-dlp -J --no-download --yes-playlist
 * --flat-playlist <url>` — the playlist enumeration pass. `--yes-playlist`
 * forces yt-dlp to honor the playlist context (default for `watch?v=X&list=Y`
 * is to fetch only the single video). `--flat-playlist` short-circuits the
 * per-video metadata pre-fetch so the call returns in seconds even for a
 * 200-entry playlist; each entry is a stub (url, id, title, duration). */
export const buildPlaylistEnumerationArgs = (
  url: string,
  options: FetchMetadataOptions,
): string[] => {
  const args = ['-J', '--no-download', '--yes-playlist', '--flat-playlist'];
  if (options.cookiesFromBrowser) {
    args.push('--cookies-from-browser', options.cookiesFromBrowser);
  }
  args.push(url);
  return args;
};

/** Build the argv for a full `yt-dlp` download invocation. The marker
 * path is returned alongside the args because the runner needs it to
 * read the final filepath yt-dlp writes via `--print-to-file`.
 *
 * Two paths:
 *
 *   1. **Auto mode** (no override / override fails to parse): we own
 *      every flag. Format args from the chosen FormatChoice, cookies,
 *      concurrency, password, URL.
 *   2. **Override mode** (override parses cleanly): the user's parsed
 *      argv replaces the auto format / cookies / `-N`. The URL is
 *      substituted into a `<URL>` placeholder if present, otherwise
 *      appended at the end. Password still appends if the override
 *      didn't already pin one.
 *
 * Framework flags (`--newline`, `--no-mtime`, `--ffmpeg-location`,
 * `--paths`, `-o`, `--progress-template`, `--print-to-file`) are
 * always emitted FIRST in both paths, so an override can shadow them
 * via yt-dlp's last-wins flag semantics if the user wants — but our
 * defaults work unmodified, and `--print-to-file` (the final-path
 * marker our queue reads) is unlikely to be overridden in practice. */
export const buildDownloadArgs = (
  opts: RunDownloadOptions,
  deps: RunnerDeps,
): { args: string[]; markerPath: string } => {
  const markerPath = join(opts.tempFolder, FINAL_PATH_MARKER_FILENAME);
  const framework = [
    '--newline',
    '--no-mtime',
    // Lock every per-row download to the single video the URL
    // identifies, never the surrounding playlist. yt-dlp's default
    // for `playlist?list=Y` URLs (and sometimes `watch?v=X&list=Y`)
    // is to iterate every entry inside a single process — which
    // breaks our queue model (one row = one video) and silently
    // downloads 50+ videos when the user only meant one. The
    // whole-playlist path goes through the dedicated enumerate +
    // per-entry enqueue flow, so it doesn't need playlist-mode
    // here either.
    '--no-playlist',
    // Space out subtitle downloads — YouTube's anonymous subtitle
    // endpoint rate-limits aggressively (HTTP 429 after roughly 2
    // requests in quick succession from an IP that's already been
    // active). 3 seconds keeps us comfortably under the threshold
    // even when the IP is in a cool-down state from prior testing.
    // Applies to every download, single-video or playlist row.
    '--sleep-subtitles',
    '3',
    // Retry on transient errors more times than yt-dlp's default
    // 10. 30 attempts gives enough headroom for the linear backoff
    // (below) to climb to 30s+ before giving up, which usually
    // outlasts a brief YouTube cool-down.
    '--retries',
    '30',
    // Linear backoff between retries — yt-dlp's default exponential
    // backoff starts fast and re-trips 429 immediately, while linear
    // 5→30 gives the rate limiter time to relax between attempts.
    '--retry-sleep',
    'linear=5:30',
    '--ffmpeg-location',
    deps.ffmpegPath,
    '--paths',
    `home:${opts.tempFolder}`,
    '-o',
    '%(title)s.%(ext)s',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--print-to-file',
    'after_move:%(filepath)s',
    markerPath,
  ];

  // Playlist-row throttle: insert a `--sleep-requests <n>` flag so
  // yt-dlp spaces out the extractor calls during the per-row metadata
  // pre-fetch. Caller (queue) sets this only for rows that belong to
  // a playlist enqueue. Single-video downloads stay snappy.
  if (opts.requestSleepSeconds !== undefined && opts.requestSleepSeconds > 0) {
    framework.push('--sleep-requests', String(opts.requestSleepSeconds));
  }

  const overrideArgs = resolveOverrideArgs(opts);
  if (overrideArgs !== undefined) {
    return { args: [...framework, ...overrideArgs], markerPath };
  }

  const autoArgs: string[] = [
    '-N',
    String(opts.concurrentFragments ?? DEFAULT_DOWNLOAD_CONCURRENCY),
    ...opts.ytDlpFormatArgs,
  ];
  if (opts.videoPassword) {
    autoArgs.push('--video-password', opts.videoPassword);
  }
  if (opts.cookiesFromBrowser) {
    autoArgs.push('--cookies-from-browser', opts.cookiesFromBrowser);
    // Subs are conditional on cookies. YouTube's anonymous subtitle
    // endpoint rate-limits hard (HTTP 429 after ~2 fetches in quick
    // succession) — even aggressive sleep + retry tuning can't beat
    // a cooled IP. Authenticated requests, on the other hand, have a
    // much higher per-account rate limit; users with cookies set rarely
    // 429. So: cookies → full subs; no cookies → no subs, but the
    // video itself downloads cleanly with no 429 risk from the sub
    // phase.
    autoArgs.push(...SUBTITLE_DOWNLOAD_FLAGS);
  }
  autoArgs.push(opts.url);

  return { args: [...framework, ...autoArgs], markerPath };
};

/** Compose the user's override into final argv: URL substitution and
 * conditional password append. Returns undefined when no override is
 * set or the override fails to parse — caller falls through to auto
 * mode in either case. */
const resolveOverrideArgs = (opts: RunDownloadOptions): string[] | undefined => {
  if (!opts.ytDlpCommandOverride) {
    return undefined;
  }
  const parsed = parseYtDlpCommand(opts.ytDlpCommandOverride);
  if (!parsed.ok) {
    return undefined;
  }
  const placeholderIdx = parsed.argv.indexOf(URL_PLACEHOLDER_TOKEN);
  const withUrl =
    placeholderIdx === -1
      ? [...parsed.argv, opts.url]
      : [
          ...parsed.argv.slice(0, placeholderIdx),
          opts.url,
          ...parsed.argv.slice(placeholderIdx + 1),
        ];
  if (opts.videoPassword && !parsed.argv.includes('--video-password')) {
    withUrl.push('--video-password', opts.videoPassword);
  }
  return withUrl;
};
