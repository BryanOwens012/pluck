import { type FormEvent, useEffect, useState } from 'react';
import { isHttpUrl } from '../../../shared/url';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { api } from '../lib/api';

type Props = {
  onSubmit: (url: string) => void;
  /** Fired on every keystroke so the parent can drive per-URL UI
   * (format probe, etc.). Already debounced inside this component for
   * the metadata prefetch, but the parent gets the raw value so it can
   * apply its own throttling if needed. Optional — components that
   * just want the submit signal can skip it. */
  onUrlChange?: (url: string) => void;
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

export const UrlInput = ({ onSubmit, onUrlChange }: Props): React.JSX.Element => {
  const [url, setUrl] = useState('');

  // Drive the prefetch off a debounced copy of the URL. The effect runs at
  // most once per stability window because `debouncedUrl` only flips after
  // the user stops typing. Parent's per-URL listener (onUrlChange) also
  // gets the debounced value — it's almost always doing IPC like the
  // format probe, which should debounce too.
  const debouncedUrl = useDebouncedValue(url.trim(), PREFETCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debouncedUrl.length < MIN_PREFETCH_URL_LENGTH || !isHttpUrl(debouncedUrl)) {
      onUrlChange?.('');
      return;
    }
    api.prefetchMetadata(debouncedUrl).catch(() => {
      // Prefetch failures are silent — the actual download attempt will
      // surface them via the friendly-error path.
    });
    onUrlChange?.(debouncedUrl);
  }, [debouncedUrl, onUrlChange]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
    setUrl('');
  };

  const isReady = url.trim().length > 0;

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 gap-2">
      <input
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="Paste a YouTube, Vimeo, or Zoom URL"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none"
      />
      <button
        type="submit"
        disabled={!isReady}
        className="rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
      >
        Download
      </button>
    </form>
  );
};
