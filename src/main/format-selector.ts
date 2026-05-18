import type { FormatChoice } from '../shared/types';
import { STATIC_FORMAT_CHOICES, STATIC_FORMAT_CHOICES_ORDERED } from '../shared/types';
import type { FormatInfo } from './ytdlp/types';

/**
 * Per-URL FormatChoice resolution. Input: yt-dlp's `formats` array.
 * Output: the four static presets with labels enriched by real per-URL
 * dimensions (e.g. "1080p (1920×1080 mp4, 60fps)") + an optional 5th
 * "Best (3840×2160 webm)" entry IFF the best non-mp4 strictly beats
 * the best mp4 by resolution, fps, or bitrate.
 *
 * Pure function. The renderer's FormatSelector falls back to the four
 * static defaults when no probe data is available (initial mount,
 * invalid URL, network failure). When a probe lands, this swaps in the
 * enriched list.
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

  const videoFormats = formats.filter((f) => f.vcodec !== 'none');
  const mp4Videos = videoFormats.filter((f) => f.ext === 'mp4');

  // No video entries at all → audio-only extractor (Vimeo for some
  // private URLs, podcast feeds). Static fallback is correct: the
  // user picks audio_mp3 and yt-dlp does its thing.
  if (videoFormats.length === 0) {
    return [...STATIC_FORMAT_CHOICES_ORDERED];
  }

  // For each height cap, find the best mp4 within it. "Best" here is
  // (height, fps, tbr) descending — matching the -S res,fps,vcodec
  // sort yt-dlp itself applies. We pre-pick so labels can describe the
  // actual file that lands on disk, not the theoretical max.
  const bestMp4Unrestricted = pickBestVideo(mp4Videos);
  const bestMp41080 = pickBestVideo(mp4Videos.filter((f) => (f.height ?? 0) <= 1080));
  const bestMp4720 = pickBestVideo(mp4Videos.filter((f) => (f.height ?? 0) <= 720));

  // Enrich the static-default labels with whatever we found. If no
  // mp4 exists in a tier (rare — Vimeo sometimes only serves webm),
  // keep the static label — the user can still try, and yt-dlp will
  // fall back through its `b[ext=mp4]` selector.
  const best = enrich(STATIC_FORMAT_CHOICES.best, bestMp4Unrestricted);
  const p1080 = enrich(STATIC_FORMAT_CHOICES['1080p'], bestMp41080);
  const p720 = enrich(STATIC_FORMAT_CHOICES['720p'], bestMp4720);
  const audio = STATIC_FORMAT_CHOICES.audio_mp3;

  const choices: FormatChoice[] = [best, p1080, p720, audio];

  // 5th option: the best non-mp4 unrestricted, IFF it strictly beats
  // the best unrestricted mp4. "Strictly beats" = higher height, OR
  // (same height AND higher fps), OR (same height AND fps AND higher
  // tbr). Equal-quality non-mp4 doesn't earn a slot — there's no
  // benefit, only the cost of a less-compatible container.
  const nonMp4Videos = videoFormats.filter((f) => f.ext !== 'mp4');
  const bestNonMp4 = pickBestVideo(nonMp4Videos);
  if (bestNonMp4 !== undefined && strictlyBeats(bestNonMp4, bestMp4Unrestricted)) {
    choices.push({
      id: 'best_alt',
      label: bestLabel(bestNonMp4),
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

/** Splice the actual dimensions + ext into a static label. When info
 * is undefined (no mp4 found in this tier), returns the static label
 * unchanged so the user still sees the preset name. */
const enrich = (base: FormatChoice, info: FormatInfo | undefined): FormatChoice => {
  if (info === undefined) {
    return base;
  }
  return { ...base, label: `${base.label} (${describeFormat(info)})` };
};

/** Label for the 5th option: "Best (3840×2160 webm)" or similar. We
 * include "Best" as the leading word so the user understands this is
 * the absolute-best-quality choice (with the trade-off of a non-mp4
 * container). */
const bestLabel = (info: FormatInfo): string => `Best (${describeFormat(info)})`;

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
