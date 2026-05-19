import { useEffect } from 'react';
import { isHttpUrl } from '../../../shared/url';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { api } from '../lib/api';

type Props = {
  /** Controlled input value. Owned by the parent so it can derive
   * validity synchronously (showing/hiding the Download button and the
   * format dropdown) without waiting on the prefetch debounce. */
  value: string;
  /** Fired on every keystroke / paste. Parent typically just stores
   * the value in state. */
  onChange: (url: string) => void;
};

// Wait this long after the user stops typing before firing the speculative
// metadata prefetch. Long enough that we don't spam yt-dlp while the user
// is mid-paste / mid-edit; short enough that by the time they reach for the
// Download button the cache has already started warming.
const PREFETCH_DEBOUNCE_MS = 400;

// Minimum URL length before we consider warming the cache. Avoids firing
// prefetch on a half-pasted URL like "h" or "https://" that yt-dlp couldn't
// resolve anyway.
const MIN_PREFETCH_URL_LENGTH = 12;

/** Pure controlled URL input. The wrapping form (and Download button)
 * live in App so Enter-submit reaches them and so the button can sit on
 * a separate row from the input. */
export const UrlInput = ({ value, onChange }: Props): React.JSX.Element => {
  const trimmed = value.trim();

  // Speculative metadata warm. The cache layer in main coalesces
  // concurrent fetches for the same URL, so it's fine that App.tsx
  // also triggers a format probe off its own debounced URL — they
  // share the cache.
  const debouncedUrl = useDebouncedValue(trimmed, PREFETCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debouncedUrl.length < MIN_PREFETCH_URL_LENGTH || !isHttpUrl(debouncedUrl)) {
      return;
    }
    api.prefetchMetadata(debouncedUrl).catch(() => {
      // Prefetch failures are silent — the actual download attempt will
      // surface them via the friendly-error path.
    });
  }, [debouncedUrl]);

  return (
    <input
      type="url"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Paste a video URL (YouTube, Instagram, TikTok, Zoom recording, etc.)"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none"
    />
  );
};
