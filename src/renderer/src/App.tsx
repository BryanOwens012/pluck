import { useEffect, useRef, useState } from 'react';
import type { Download, Format } from '../../shared/types';
import { DownloadQueue } from './components/DownloadQueue';
import { FormatSelector } from './components/FormatSelector';
import { PasswordPrompt } from './components/PasswordPrompt';
import { SettingsPanel } from './components/SettingsPanel';
import { UrlInput } from './components/UrlInput';
import { api } from './lib/api';

const App = (): React.JSX.Element => {
  // Keyed by Download.id so push updates replace by id; rendered as a list
  // sorted by createdAt descending (newest first). One state owner, one
  // consumer (DownloadQueue) — no need for a global store yet.
  const [downloads, setDownloads] = useState<Map<string, Download>>(() => new Map());
  const [format, setFormat] = useState<Format>('best');
  // Settings snapshot. Loaded once on mount and refreshed after a save
  // from SettingsPanel. The folder picker lives inside Settings now;
  // App keeps the value so startDownload doesn't need to re-fetch.
  const [outputFolder, setOutputFolder] = useState<string | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Currently-open password prompt, by row id. Single modal at a time.
  const [passwordPromptId, setPasswordPromptId] = useState<string | undefined>(undefined);
  // Rows the user has explicitly dismissed without entering a password,
  // tracked by (id, attemptCount). A new wrong-password update (attempt
  // bumps) auto-reopens the modal; a dismissal at the *same* attempt
  // count keeps it closed. Ref because we only need it for the effect's
  // decision logic — re-rendering on every push would be wasteful.
  const dismissedRef = useRef<Map<string, number>>(new Map());

  // Boot: subscribe to push updates first so any update emitted while
  // getInitialState is in-flight still lands. Seed merges with existing-
  // wins semantics — a newer pushed row isn't clobbered by the older
  // snapshot from main.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.onDownloadUpdate((download) => {
      setDownloads((prev) => {
        const next = new Map(prev);
        next.set(download.id, download);
        return next;
      });
    });
    api
      .getInitialState()
      .then((initial) => {
        if (cancelled) {
          return;
        }
        setDownloads((prev) => {
          const next = new Map(prev);
          for (const d of initial) {
            if (!next.has(d.id)) {
              next.set(d.id, d);
            }
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        console.error('getInitialState rejected:', err);
      });
    api
      .getSettings()
      .then((settings) => {
        if (!cancelled) {
          setOutputFolder(settings.outputFolder);
        }
      })
      .catch((err: unknown) => {
        console.error('getSettings rejected:', err);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Manage the password-prompt modal:
  //   (a) Auto-close if the currently-prompted row left needs_password
  //       (correct password succeeded, user cancelled, or 3rd attempt
  //       terminated it). Keeps a stale modal from floating over an
  //       already-resolved row.
  //   (b) Otherwise, auto-open for any needs_password row the user
  //       hasn't dismissed at the current attempt count. Idempotent —
  //       the same (id, attempts) pair only opens once; a wrong-password
  //       push bumps attempts and re-pops.
  useEffect(() => {
    if (passwordPromptId !== undefined) {
      const current = downloads.get(passwordPromptId);
      if (!current || current.status !== 'needs_password') {
        setPasswordPromptId(undefined);
      }
      return;
    }
    for (const download of downloads.values()) {
      if (download.status !== 'needs_password') {
        continue;
      }
      const attempts = download.passwordAttempts ?? 0;
      if (dismissedRef.current.get(download.id) !== attempts) {
        setPasswordPromptId(download.id);
        return;
      }
    }
  }, [downloads, passwordPromptId]);

  const handleSubmit = (url: string): void => {
    api.startDownload({ url, format }).catch((err: unknown) => {
      console.error('startDownload rejected:', err);
    });
  };

  const handleDismissPasswordPrompt = (): void => {
    if (passwordPromptId !== undefined) {
      const current = downloads.get(passwordPromptId);
      dismissedRef.current.set(passwordPromptId, current?.passwordAttempts ?? 0);
    }
    setPasswordPromptId(undefined);
  };

  const handleOpenPasswordPrompt = (id: string): void => {
    // Reopening from the row button — drop the dismissal so the effect
    // would re-pop next time too. Set directly for the immediate open.
    dismissedRef.current.delete(id);
    setPasswordPromptId(id);
  };

  const rows = Array.from(downloads.values()).sort((a, b) => b.createdAt - a.createdAt);
  const promptDownload = passwordPromptId ? downloads.get(passwordPromptId) : undefined;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">Pluck</h1>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open settings"
            title="Settings"
            className="rounded p-1.5 text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100"
          >
            <GearIcon />
          </button>
        </header>
        <div className="flex gap-2">
          <UrlInput onSubmit={handleSubmit} />
          <FormatSelector value={format} onChange={setFormat} />
        </div>
        <DownloadQueue rows={rows} onOpenPasswordPrompt={handleOpenPasswordPrompt} />
      </div>
      {promptDownload ? (
        <PasswordPrompt download={promptDownload} onDismiss={handleDismissPasswordPrompt} />
      ) : null}
      {settingsOpen && outputFolder !== undefined ? (
        <SettingsPanel
          outputFolder={outputFolder}
          onOutputFolderChange={setOutputFolder}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </main>
  );
};

/** Header gear icon. Lucide-style stroke, inline so we don't pull a
 * full icon dep just for one button. */
const GearIcon = (): React.JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="h-5 w-5"
  >
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </svg>
);

export default App;
