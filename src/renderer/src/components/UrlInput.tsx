import { type FormEvent, useState } from 'react';

type Props = {
  onSubmit: (url: string) => void;
  disabled?: boolean;
};

export const UrlInput = ({ onSubmit, disabled }: Props): React.JSX.Element => {
  const [url, setUrl] = useState('');

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
    setUrl('');
  };

  const isReady = url.trim().length > 0 && !disabled;

  return (
    <form onSubmit={handleSubmit} className="flex flex-1 gap-2">
      <input
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="Paste a YouTube, Vimeo, or Zoom URL"
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none disabled:opacity-50"
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
