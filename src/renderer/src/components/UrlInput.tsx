import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../lib/api';

type Props = {
  onSubmit: (url: string) => void;
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

export const UrlInput = ({ onSubmit }: Props): React.JSX.Element => {
  const [url, setUrl] = useState('');

  // Debounced metadata prefetch. Every keystroke clears the prior timer and
  // schedules a new one; only the last keystroke's timer actually fires.
  // Empty deps would be wrong here — we need to react to `url` changing —
  // but the cleanup is what keeps us from queuing up dozens of fetches.
  useEffect(() => {
    const trimmed = url.trim();
    if (trimmed.length < MIN_PREFETCH_URL_LENGTH || !/^https?:\/\//i.test(trimmed)) {
      return;
    }
    const handle = setTimeout(() => {
      api.prefetchMetadata(trimmed).catch(() => {
        // Prefetch failures are silent — the actual download attempt will
        // surface them via the friendly-error path.
      });
    }, PREFETCH_DEBOUNCE_MS);
    return (): void => {
      clearTimeout(handle);
    };
  }, [url]);

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
