import type { FormatChoice } from '../../../shared/types';
import { STATIC_FORMAT_CHOICES, STATIC_FORMAT_CHOICES_ORDERED } from '../../../shared/types';
import type { FormatInfo } from '../../ytdlp/types';

/**
 * Per-URL FormatChoice resolution. Input: yt-dlp's `formats` array.
 * Output: a dynamic dropdown list built from the probed metadata.
 *
 * Pre-probe labels (the renderer's PROBING_PLACEHOLDER_CHOICES) read:
 *
 *   Best
 *   1080p mp4
 *   720p mp4
 *   480p mp4
 *   360p mp4
 *   Audio-only mp3
 *
 * Post-probe, "Best" gains a detail suffix describing the resolution
 * AND the actual merged output container — e.g. "Best (1080p mp4)"
 * when the source's top non-AV1 stream merges to mp4, "Best (4K mkv)"
 * when it merges to mkv (mp4 video + webm audio, or vice versa). The
 * container distinction is meaningful for users who care about iMovie
 * / Final Cut compatibility.
 *
 * The lower-tier rows survive only when they're (a) actually available
 * as non-AV1 mp4 at the URL and (b) NOT duplicates of what "Best"
 * already resolves to. The `audio_mp3` row is always included so
 * audio-only extraction stays one click away.
 *
 * AV1 is filtered out entirely. On YouTube, AV1 is the only codec at
 * 8K (no h264 or VP9 alternative), so this filter caps the dropdown
 * at the highest non-AV1 stream — 4K VP9 in practice. Users who want
 * AV1 can use the override box in Settings.
 *
 * Pure function. The renderer's FormatSelector falls back to the
 * static defaults (with "mp4" suffixes baked into the labels) when no
 * probe data is available (initial mount, invalid URL, network
 * failure).
 */
export const resolveFormatChoices = (formats: readonly FormatInfo[]): FormatChoice[] => {
  // Audio-only URL or unparsed formats array: stick to defaults.
  // The user can still pick audio_mp3 manually (yt-dlp will pick the
  // sole audio stream regardless of our labels).
  if (formats.length === 0) {
    return [...STATIC_FORMAT_CHOICES_ORDERED];
  }

  const videoFormats = formats.filter((f) => f.vcodec !== 'none' && !isAv1(f));
  const audioFormats = formats.filter((f) => f.acodec !== 'none' && f.vcodec === 'none');
  const mp4Videos = videoFormats.filter((f) => f.ext === 'mp4');

  // No non-AV1 video entries at all → audio-only extractor (Vimeo for
  // some private URLs, podcast feeds) or an AV1-only source. Static
  // fallback is correct: the user picks audio_mp3 and yt-dlp does its
  // thing.
  if (videoFormats.length === 0) {
    return [...STATIC_FORMAT_CHOICES_ORDERED];
  }

  // The "Best" pick uses the unrestricted top non-AV1 video. This
  // matches what QUALITY_FIRST_BEST_CHOICE actually downloads pre-
  // probe, so the post-probe detail describes the file the user will
  // get if they click Best now.
  const bestVideo = pickBestVideo(videoFormats);
  if (bestVideo === undefined) {
    return [...STATIC_FORMAT_CHOICES_ORDERED];
  }

  // Predict the merged output container. yt-dlp keeps mp4 when both
  // video and audio sit in compatible mp4-family containers (m4a is
  // mp4-family). Mixed-container merges (mp4 video + webm audio, or
  // webm video + m4a audio) get muxed to mkv.
  const m4aAudio = audioFormats.find((a) => a.ext === 'm4a');
  const mergedContainer = bestVideo.ext === 'mp4' && m4aAudio !== undefined ? 'mp4' : 'mkv';
  const bestShorthand = bestVideo.height !== undefined ? resolutionShorthand(bestVideo.height) : '';
  const bestDetail = bestShorthand ? `${bestShorthand} ${mergedContainer}` : mergedContainer;
  const best: FormatChoice = {
    ...STATIC_FORMAT_CHOICES.best,
    detail: bestDetail,
    shorthand: bestShorthand,
  };

  // Lower-tier inclusion is filtered against what's actually available:
  //   1. Drop tier if its height matches "Best"'s pick — no duplicate
  //      row would show the same file under two labels.
  //   2. Drop tier if the URL doesn't offer a non-AV1 mp4 stream at
  //      (or above) that height. Otherwise picking the tier would
  //      silently fall to a lower-res stream and confuse the user.
  // VIDEO_TIER_PRESETS lists tiers in descending order (1080p, 720p,
  // 480p, 360p), the same order they're displayed in the dropdown.
  const choices: FormatChoice[] = [best];
  const bestHeight = bestVideo.height ?? 0;
  for (const tier of VIDEO_TIER_PRESETS) {
    if (bestHeight === tier.height) {
      // Dedupe: Best already resolves to this exact tier.
      continue;
    }
    const tierMp4 = pickBestVideo(mp4Videos.filter((f) => (f.height ?? 0) <= tier.height));
    if ((tierMp4?.height ?? 0) < tier.height) {
      continue;
    }
    choices.push(STATIC_FORMAT_CHOICES[tier.id]);
  }
  choices.push(STATIC_FORMAT_CHOICES.audio_mp3);

  return choices;
};

/** Tier heights for the lower-resolution mp4 entries. Order matters —
 * displayed in this order in the dropdown. */
const VIDEO_TIER_PRESETS = [
  { id: '1080p', height: 1080 },
  { id: '720p', height: 720 },
  { id: '480p', height: 480 },
  { id: '360p', height: 360 },
] as const satisfies ReadonlyArray<{
  id: '1080p' | '720p' | '480p' | '360p';
  height: number;
}>;

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

/** True for any format whose vcodec id starts with "av01" — the yt-dlp
 * codec naming convention for AV1. Matches the runtime filter
 * `[vcodec!*=av01]` in QUALITY_FIRST_BEST_CHOICE so labels stay
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
