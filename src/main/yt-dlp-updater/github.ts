import { z } from 'zod';

/** GitHub Releases API — yt-dlp's stable channel. We only ever
 * read this endpoint (no authentication), so the 60-requests/hour
 * unauthenticated rate limit is plenty for "check on launch + on
 * manual button". */
const LATEST_RELEASE_URL = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';

/** Name of the macOS universal binary inside the release's assets
 * array. yt-dlp's macOS build is already arm64+x86_64; one binary
 * works on both arches. */
const MACOS_ASSET_NAME = 'yt-dlp_macos';

/** Schema for the subset of GitHub's release JSON we read. yt-dlp's
 * tag_name is the version string (e.g. `2026.05.18`). Each asset
 * exposes `browser_download_url` for direct fetching.
 *
 * Zod 4 `z.looseObject` lets GitHub's hundreds of other fields pass
 * through silently — we only validate what we touch. */
const GitHubReleaseSchema = z.looseObject({
  tag_name: z.string(),
  assets: z.array(
    z.looseObject({
      name: z.string(),
      browser_download_url: z.url(),
    }),
  ),
});

export type LatestReleaseInfo = {
  /** Version string from `tag_name` — same shape as the local
   * `yt-dlp --version` output so version comparison is a straight
   * string equality (yt-dlp uses calendar versioning, `YYYY.MM.DD`,
   * which lexically sorts in chronological order). */
  version: string;
  /** Direct download URL for the macOS binary. */
  downloadUrl: string;
};

/** Fetch the latest yt-dlp release from GitHub. Returns just the
 * fields the updater needs; the rest of GitHub's response is
 * discarded. Throws with a useful message on network failure,
 * 5xx, malformed JSON, or missing macOS asset so the caller can
 * surface a specific error in Settings. */
export const fetchLatestRelease = async (): Promise<LatestReleaseInfo> => {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: {
      // GitHub's API recommends an Accept header; without it the
      // response shape can shift between v3 and the legacy beta
      // shape on edge endpoints.
      Accept: 'application/vnd.github+json',
      // Identify ourselves — GitHub asks for a User-Agent on all
      // API calls; the docs say "in many cases requests without
      // it will be denied".
      'User-Agent': 'Pluck-yt-dlp-updater',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub releases responded ${response.status}`);
  }
  const json: unknown = await response.json();
  const parsed = GitHubReleaseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('GitHub release JSON failed schema validation');
  }
  const macAsset = parsed.data.assets.find((a) => a !== undefined && a.name === MACOS_ASSET_NAME);
  if (!macAsset) {
    throw new Error(`No "${MACOS_ASSET_NAME}" asset in the latest yt-dlp release`);
  }
  return {
    version: parsed.data.tag_name,
    downloadUrl: macAsset.browser_download_url,
  };
};
