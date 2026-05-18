import { useEffect, useRef, useState } from 'react';
import type { Download } from '../../../shared/types';
import { api } from '../lib/api';

type Props = {
  /** The row waiting in 'needs_password'. Modal pulls its url + title
   * for context so the user knows which video they're entering a
   * password for (multi-row queues). */
  download: Download;
  onDismiss: () => void;
};

/** Centered modal over the queue. Backdrop click + Esc both dismiss
 * without consuming a password attempt. Submit sends the password to
 * main and dismisses; main flips the row back to 'queued' and re-runs.
 * If the password was wrong, the row returns to 'needs_password' with
 * an incremented `passwordAttempts` — App re-opens the modal and we
 * show the attempt count as a hint. */
export const PasswordPrompt = ({ download, onDismiss }: Props): React.JSX.Element => {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus the password field on mount so the user can type
  // immediately. App unmounts + remounts the modal per row (single-modal
  // design), so a fresh mount is all we need.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    const trimmed = password.trim();
    if (trimmed.length === 0) {
      return;
    }
    api.submitPassword(download.id, trimmed).catch((err: unknown) => {
      console.error('submitPassword rejected:', err);
    });
    onDismiss();
  };

  // Show the wrong-password hint only after the first failed attempt
  // (passwordAttempts > 0). The first prompt has no error context yet.
  const attempts = download.passwordAttempts ?? 0;
  const heading = download.title ?? download.url;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-prompt-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        // Backdrop click dismisses; clicks inside the form land on form
        // / input / button elements, so event.target !== currentTarget
        // (the backdrop div). No stopPropagation needed.
        if (event.target === event.currentTarget) {
          onDismiss();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onDismiss();
        }
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-xl"
      >
        <div className="space-y-1">
          <h2 id="password-prompt-title" className="text-sm font-medium text-neutral-100">
            This recording requires a password
          </h2>
          <div className="truncate text-xs text-neutral-400" title={heading}>
            {heading}
          </div>
        </div>
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          autoComplete="off"
          className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
        />
        {attempts > 0 ? (
          <div className="text-xs text-red-400">
            Incorrect password. Attempt {attempts + 1} of 3.
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={password.trim().length === 0}
            className="rounded-md border border-neutral-600 bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Submit
          </button>
        </div>
      </form>
    </div>
  );
};
