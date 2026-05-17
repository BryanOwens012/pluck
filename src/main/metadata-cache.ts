/**
 * Tiny in-process cache wrapped around any URL → metadata fetcher. The IPC
 * layer uses it to speculatively prefetch yt-dlp metadata when the user
 * pastes a URL (~400 ms debounced), so by the time they click Download the
 * row jumps straight to "Starting download…" rather than spending the 2–4 s
 * yt-dlp cold-start window in "Reading video info…".
 *
 * Deliberately bare:
 * - No TTL. Metadata doesn't change between "user pasted URL" and "user
 *   clicked Download" seconds later. Stale across app restarts is fine
 *   because the Map dies with the process.
 * - No LRU eviction. Even a heavy session is a handful of distinct URLs;
 *   each metadata object is tiny.
 * - No persistence. Cross-session caching of yt-dlp metadata is risky
 *   (extractor fields drift) and PR 12.5's SQLite library handles the
 *   "videos I've downloaded before" question separately.
 *
 * Two behaviours that DO matter and are implemented:
 * 1. **In-flight de-dup**: concurrent get(url) calls share one fetcher
 *    invocation. Otherwise the prefetch + the click could race and spawn
 *    two yt-dlp processes for the same URL.
 * 2. **Failure eviction**: a rejected fetch is dropped so the next caller
 *    retries cleanly rather than receiving a cached error.
 */

import type { VideoMetadata } from './ytdlp/types';

export type MetadataCache = {
  /** Fetch metadata for a URL, hitting the cache when available, falling
   * through to the fetcher otherwise. Rejections propagate. */
  get: (url: string) => Promise<VideoMetadata>;
  /** Fire-and-forget cache warmer. Errors are swallowed (the real download
   * attempt will surface them). */
  prefetch: (url: string) => void;
  /** For tests / diagnostics. */
  size: () => number;
};

export const createMetadataCache = (
  fetcher: (url: string) => Promise<VideoMetadata>,
): MetadataCache => {
  const cache = new Map<string, Promise<VideoMetadata>>();

  const get = (url: string): Promise<VideoMetadata> => {
    const existing = cache.get(url);
    if (existing !== undefined) {
      return existing;
    }
    const promise = fetcher(url).catch((err: unknown) => {
      // Evict the failed entry so the next call retries fresh instead of
      // receiving the cached rejection forever.
      if (cache.get(url) === promise) {
        cache.delete(url);
      }
      throw err;
    });
    cache.set(url, promise);
    return promise;
  };

  return {
    get,
    prefetch: (url) => {
      get(url).catch(() => {
        // Intentionally swallowed — see docstring.
      });
    },
    size: () => cache.size,
  };
};
