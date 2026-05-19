import type { FormatChoice } from '../shared/types';
import { STATIC_FORMAT_CHOICES, STATIC_FORMAT_CHOICES_ORDERED } from '../shared/types';
import type { FormatInfo } from './ytdlp/types';

/**
 * Per-URL FormatChoice resolution. Input: yt-dlp's `formats` array.
 * Output: a dynamic dropdown list built from the probed metadata:
 *   - "Best quality" with a resolution shorthand attached (e.g. "4K",
 *     "1080p", "720p") so the user sees what they'll get.
 *   - Lower mp4 tiers (1080p / 720p) — included only when (a) an
 *     mp4 stream actually exists at that height and (b) it isn't a
 *     duplicate of the "Best quality" pick.
 *   - "Audio only (mp3)" — always.
 *   - Optional 5th `best_alt` entry labelled by shorthand + container
 *     ("4K (webm)") when a non-mp4 stream strictly beats the best mp4.
 *
 * AV1-in-mp4 is filtered out across the board because M1 / M2 Macs
 * have no hardware AV1 decode and QuickTime treats some AV1 files as
 * corrupt. Both the format-args and the label-picking logic stay in
 * sync via the same filter applied here.
 *
 * Pure function. The renderer's FormatSelector falls back to the four
 * static defaults when no probe data is available (initial mount,
 * invalid URL, network failure).
 *
 * Module is decoupled from the runner / IPC layer — feed it any
 * FormatInfo[] (real-world or test fixture) and it returns a stable
 * FormatChoice[].
 */
export const resolveFormatChoices = (formats: readonly FormatInfo[]): FormatChoice[] => {
  // Audio-only URL or unparsed formats array: stick to defaults.
  // The user can still pick audio_mp3 manually (yt-dlp will pick the
  // sole audio stream regardless of our labels).
  if (formats.length === 0) {
    return [...STATIC_FORMAT_CHOICES_ORDERED];
  }

  // Exclude AV1 streams everywhere — they don't decode well on M1/M2.
  // The runtime -f filter has the same `[vcodec!*=av01]` clause, so
  // keeping the label logic in step means the dropdown never advertises
  // a stream that yt-dlp won't actually download.
  const videoFormats = formats.filter((f) => f.vcodec !== 'none' && !isAv1(f));
  const mp4Videos = videoFormats.filter((f) => f.ext === 'mp4');

  // No video entries at all → audio-only extractor (Vimeo for some
  // private URLs, podcast feeds). Static fallback is correct: the
  // user picks audio_mp3 and yt-dlp does its thing.
  if (videoFormats.length === 0) {
    return [...STATIC_FORMAT_CHOICES_ORDERED];
  }

  // For each height cap, find the best mp4 within it. "Best" here is
  // (height, fps, tbr) descending. We pre-pick so labels can describe
  // the actual file that lands on disk, not the theoretical max.
  const bestMp4Unrestricted = pickBestVideo(mp4Videos);
  const bestMp41080 = pickBestVideo(mp4Videos.filter((f) => (f.height ?? 0) <= 1080));
  const bestMp4720 = pickBestVideo(mp4Videos.filter((f) => (f.height ?? 0) <= 720));

  // Enrich the static-default labels with whatever we found. If no
  // mp4 exists in a tier, keep the static base unchanged (no `detail`)
  // — yt-dlp will fall back through its `b[ext=mp4]` selector. Only
  // 'best' gets a shorthand bucket because the 1080p / 720p entries
  // already say their resolution in the label.
  const best = enrich(STATIC_FORMAT_CHOICES.best, bestMp4Unrestricted, { withShorthand: true });
  const p1080 = enrich(STATIC_FORMAT_CHOICES['1080p'], bestMp41080);
  const p720 = enrich(STATIC_FORMAT_CHOICES['720p'], bestMp4720);
  const audio = STATIC_FORMAT_CHOICES.audio_mp3;

  // Lower tiers are filtered against what's actually available:
  //   1. Drop tier if its shorthand matches "Best"'s — no duplicate row.
  //   2. Drop tier if the URL doesn't offer an mp4 stream at (or above)
  //      that height. Otherwise picking the tier would silently fall
  //      back to a lower-res stream and confuse the user.
  const choices: FormatChoice[] = [best];
  if (best.shorthand !== '1080p' && (bestMp41080?.height ?? 0) >= 1080) {
    choices.push(p1080);
  }
  if (best.shorthand !== '720p' && (bestMp4720?.height ?? 0) >= 720) {
    choices.push(p720);
  }
  choices.push(audio);

  // 5th option: the best non-mp4 unrestricted, IFF it strictly beats
  // the best unrestricted mp4. "Strictly beats" = higher height, OR
  // (same height AND higher fps), OR (same height AND fps AND higher
  // tbr). Equal-quality non-mp4 doesn't earn a slot — there's no
  // benefit, only the cost of a less-compatible container.
  const nonMp4Videos = videoFormats.filter((f) => f.ext !== 'mp4');
  const bestNonMp4 = pickBestVideo(nonMp4Videos);
  if (bestNonMp4 !== undefined && strictlyBeats(bestNonMp4, bestMp4Unrestricted)) {
    // Label uses the resolution shorthand ("4K"); detail is just the
    // container ("webm"). FormatSelector always shows detail for
    // best_alt regardless of debug mode, so users see e.g. "4K (webm)"
    // at the bottom of the dropdown — telling them in two tokens that
    // this is the higher-quality alternative in a different container.
    const altLabel =
      bestNonMp4.height !== undefined ? resolutionShorthand(bestNonMp4.height) : 'Best';
    choices.push({
      id: 'best_alt',
      label: altLabel,
      detail: bestNonMp4.ext,
      // Match by container ext + the same -S sort. No height cap (this
      // is the "give me the best regardless of container" path).
      ytDlpFormatArgs: [
        '-f',
        `bv*[ext=${bestNonMp4.ext}]+ba/b[ext=${bestNonMp4.ext}]`,
        '-S',
        'res,fps,tbr',
      ],
    });
  }

  return choices;
};

/** Comparator: returns true iff `a` strictly beats `b` on the (height,
 * fps, tbr) ladder. `undefined` b counts as "no mp4 was found"; the
 * non-mp4 entry then trivially earns its slot. */
const strictlyBeats = (a: FormatInfo, b: FormatInfo | undefined): boolean => {
  if (b === undefined) {
    return true;
  }
  const ah = a.height ?? 0;
  const bh = b.height ?? 0;
  if (ah !== bh) {
    return ah > bh;
  }
  const af = a.fps ?? 0;
  const bf = b.fps ?? 0;
  if (af !== bf) {
    return af > bf;
  }
  const at = a.tbr ?? 0;
  const bt = b.tbr ?? 0;
  return at > bt;
};

/** Pick the best video format by (height, fps, tbr) descending. Empty
 * input returns undefined so callers can branch. */
const pickBestVideo = (entries: readonly FormatInfo[]): FormatInfo | undefined => {
  if (entries.length === 0) {
    return undefined;
  }
  return [...entries].sort((a, b) => {
    const dh = (b.height ?? 0) - (a.height ?? 0);
    if (dh !== 0) {
      return dh;
    }
    const df = (b.fps ?? 0) - (a.fps ?? 0);
    if (df !== 0) {
      return df;
    }
    return (b.tbr ?? 0) - (a.tbr ?? 0);
  })[0];
};

/** Attach the actual dimensions + ext as `detail` (visible in debug
 * mode) and, optionally, a terse resolution shorthand like "1080p" or
 * "4K" (visible always) without changing the base label. When `info`
 * is undefined (no mp4 found in this tier), the base is returned
 * unchanged — the user still sees the preset name and no stale data
 * gets attached. */
const enrich = (
  base: FormatChoice,
  info: FormatInfo | undefined,
  options: { withShorthand?: boolean } = {},
): FormatChoice => {
  if (info === undefined) {
    return base;
  }
  const enriched: FormatChoice = { ...base, detail: describeFormat(info) };
  if (options.withShorthand && info.height !== undefined) {
    enriched.shorthand = resolutionShorthand(info.height);
  }
  return enriched;
};

/** True for any format whose vcodec id starts with "av01" — the yt-dlp
 * codec naming convention for AV1. Matches the runtime filter
 * `[vcodec!*=av01]` we set in STATIC_FORMAT_CHOICES so labels stay
 * consistent with what actually downloads. */
const isAv1 = (info: FormatInfo): boolean => info.vcodec.startsWith('av01');

/** Bucket a pixel height into the consumer-facing tier name. Mapping
 * matches the names users recognise — "4K" not "2160p", "1080p" not
 * "2K" — and floors anything tiny at 240p. */
const resolutionShorthand = (height: number): string => {
  if (height >= 4320) {
    return '8K';
  }
  if (height >= 3000) {
    return '6K';
  }
  if (height >= 2880) {
    return '5K';
  }
  if (height >= 2160) {
    return '4K';
  }
  if (height >= 1440) {
    return '2K';
  }
  if (height >= 1080) {
    return '1080p';
  }
  if (height >= 720) {
    return '720p';
  }
  if (height >= 480) {
    return '480p';
  }
  if (height >= 360) {
    return '360p';
  }
  return '240p';
};

/** Compose the parenthesised detail string. Shape examples:
 *  - "1920×1080 mp4"
 *  - "1920×1080 mp4, 60fps"
 *  - "1080p mp4" (when yt-dlp only gave us a height, not width)
 *
 * Comma before the fps so the eye can split "dimensions + container"
 * (the primary axis) from "framerate" (the qualifier). */
const describeFormat = (info: FormatInfo): string => {
  let main: string;
  if (info.width !== undefined && info.height !== undefined) {
    main = `${info.width}×${info.height} ${info.ext}`;
  } else if (info.height !== undefined) {
    main = `${info.height}p ${info.ext}`;
  } else {
    main = info.ext;
  }
  if (info.fps !== undefined && info.fps > 30) {
    return `${main}, ${Math.round(info.fps)}fps`;
  }
  return main;
};
