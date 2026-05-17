import { describe, expect, it, vi } from 'vitest';
import { createMetadataCache } from './metadata-cache';
import type { VideoMetadata } from './ytdlp/types';

const fakeMeta = (id: string): VideoMetadata => ({
  id,
  title: `Video ${id}`,
  extractor: 'youtube',
});

describe('createMetadataCache', () => {
  it('hits the fetcher on first get for a URL', async () => {
    const fetcher = vi.fn(async (url: string) => fakeMeta(url));
    const cache = createMetadataCache(fetcher);

    const meta = await cache.get('https://youtube.com/watch?v=a');
    expect(meta.title).toBe('Video https://youtube.com/watch?v=a');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns the cached promise on subsequent gets without re-calling the fetcher', async () => {
    const fetcher = vi.fn(async (url: string) => fakeMeta(url));
    const cache = createMetadataCache(fetcher);

    await cache.get('url-a');
    await cache.get('url-a');
    await cache.get('url-a');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('de-dupes concurrent in-flight requests for the same URL', async () => {
    // Hold the fetcher's promise so two gets land while it's in flight.
    let resolveFetcher: ((meta: VideoMetadata) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<VideoMetadata>((resolve) => {
          resolveFetcher = resolve;
        }),
    );
    const cache = createMetadataCache(fetcher);

    const a = cache.get('url-a');
    const b = cache.get('url-a');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(a).toBe(b);

    resolveFetcher?.(fakeMeta('url-a'));
    await Promise.all([a, b]);
  });

  it('evicts entries on rejection so the next call retries with a fresh fetch', async () => {
    let callIndex = 0;
    const fetcher = vi.fn(async (url: string) => {
      callIndex += 1;
      if (callIndex === 1) {
        throw new Error('network down');
      }
      return fakeMeta(url);
    });
    const cache = createMetadataCache(fetcher);

    await expect(cache.get('url-a')).rejects.toThrow('network down');
    const meta = await cache.get('url-a');
    expect(meta.title).toBe('Video url-a');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('prefetch swallows errors and never throws', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('boom');
    });
    const cache = createMetadataCache(fetcher);

    expect(() => cache.prefetch('url-a')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Failure eviction cleared the entry.
    expect(cache.size()).toBe(0);
  });

  it('prefetch + later get on the same URL share the in-flight fetch', async () => {
    let resolveFetcher: ((meta: VideoMetadata) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<VideoMetadata>((resolve) => {
          resolveFetcher = resolve;
        }),
    );
    const cache = createMetadataCache(fetcher);

    cache.prefetch('url-a');
    const getPromise = cache.get('url-a');
    expect(fetcher).toHaveBeenCalledOnce();

    resolveFetcher?.(fakeMeta('url-a'));
    await expect(getPromise).resolves.toMatchObject({ title: 'Video url-a' });
  });
});
