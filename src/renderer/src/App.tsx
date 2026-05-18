import { useEffect, useRef, useState } from 'react';
import {
  type DebugLogEvent,
  type Download,
  type FormatChoice,
  STATIC_FORMAT_CHOICES,
  STATIC_FORMAT_CHOICES_ORDERED,
} from '../../shared/types';
import { DownloadQueue } from './components/DownloadQueue';
import { FormatSelector } from './components/FormatSelector';
import { PasswordPrompt } from './components/PasswordPrompt';
import { SettingsPanel } from './components/SettingsPanel';
import { UrlInput } from './components/UrlInput';
import { api } from './lib/api';

/** Per-download log buffer cap. Debug mode for one long Zoom recording
 * shouldn't balloon renderer memory — we drop the oldest lines when
 * the buffer hits this size. 500 lines is roughly 8-10 minutes of
 * throttled progress + scattered yt-dlp chatter. */
const MAX_LOG_LINES_PER_ID = 500;

const App = (): React.JSX.Element => {
  // Keyed by Download.id so push updates replace by id; rendered as a list
  // sorted by createdAt descending (newest first). One state owner, one
  // consumer (DownloadQueue) — no need for a global store yet.
  const [downloads, setDownloads] = useState<Map<string, Download>>(() => new Map());
  // Currently-selected FormatChoice. Default to the static "Best
  // Quality" entry; the per-URL probe effect below swaps in an enriched
  // list once metadata lands and re-resolves the selection by id so the
  // user's pick stays stable across re-probes.
  const [format, setFormat] = useState<FormatChoice>(STATIC_FORMAT_CHOICES.best);
  // Available choices for the dropdown. Starts as the four static
  // defaults; the per-URL probe (triggered when the URL input changes)
  // replaces them with enriched labels (real dimensions, fps, container)
  // plus an optional 5th non-mp4 alternative. Selection is preserved
  // across re-probes by id — if the user had picked '1080p' and the new
  // probe still has a '1080p' entry, the dropdown stays on it even
  // though the label may have changed.
  const [formatChoices, setFormatChoices] = useState<readonly FormatChoice[]>(
    STATIC_FORMAT_CHOICES_ORDERED,
  );
  const [pendingUrl, setPendingUrl] = useState('');
  // Settings snapshot. Loaded once on mount and refreshed after a save
  // from SettingsPanel. The folder picker lives inside Settings now;
  // App keeps the value so startDownload doesn't need to re-fetch.
  const [outputFolder, setOutputFolder] = useState<string | undefined>(undefined);
  const [debugMode, setDebugMode] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Per-id log buffers. Only populated when debugMode is true (main
  // gates emits there too). Capped per-id at MAX_LOG_LINES_PER_ID —
  // older lines fall off the front when the buffer fills.
  const [debugLogs, setDebugLogs] = useState<Map<string, readonly DebugLogEvent[]>>(
    () => new Map(),
  );
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
          setDebugMode(settings.debugMode);
        }
      })
      .catch((err: unknown) => {
        console.error('getSettings rejected:', err);
      });
    // Always subscribe to debug-log pushes — main only emits when its
    // own getDebugMode() returns true, so an unsubscribed-but-on
    // listener would still see zero traffic. Subscribing
    // unconditionally also handles the case where the user flips the
    // toggle mid-session: events start arriving without a remount.
    const unsubscribeDebug = api.onDebugLog((event) => {
      setDebugLogs((prev) => {
        const next = new Map(prev);
        const existing = next.get(event.id) ?? [];
        const updated = [...existing, event];
        // Drop oldest when over the cap. Slicing is O(n) but n is
        // bounded at MAX_LOG_LINES_PER_ID so this is fine.
        if (updated.length > MAX_LOG_LINES_PER_ID) {
          updated.splice(0, updated.length - MAX_LOG_LINES_PER_ID);
        }
        next.set(event.id, updated);
        return next;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeDebug();
    };
  }, []);

  // Per-URL format probe. When the user types a URL in UrlInput (which
  // debounces + calls api.prefetchMetadata), pendingUrl reflects the
  // current value. We hit api.getFormatChoices to enrich the dropdown.
  // The IPC handler shares the metadataCache with prefetch, so this is
  // typically a cache hit (free). Selection is preserved across re-probes
  // by id — if the new choices include the same id the user had picked,
  // we keep it; otherwise we fall back to the first entry (Best).
  useEffect(() => {
    const url = pendingUrl.trim();
    if (url.length === 0) {
      setFormatChoices(STATIC_FORMAT_CHOICES_ORDERED);
      return;
    }
    let cancelled = false;
    api
      .getFormatChoices(url)
      .then((choices) => {
        if (cancelled || choices.length === 0) {
          return;
        }
        setFormatChoices(choices);
        // Preserve selection by id; fall back to first choice if the
        // previously-selected id is no longer in the list.
        setFormat((prev) => choices.find((c) => c.id === prev.id) ?? choices[0] ?? prev);
      })
      .catch((err: unknown) => {
        console.error('getFormatChoices rejected:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [pendingUrl]);

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
          <UrlInput onSubmit={handleSubmit} onUrlChange={setPendingUrl} />
          <FormatSelector value={format} onChange={setFormat} choices={formatChoices} />
        </div>
        <DownloadQueue
          rows={rows}
          onOpenPasswordPrompt={handleOpenPasswordPrompt}
          debugMode={debugMode}
          debugLogs={debugLogs}
        />
      </div>
      {promptDownload ? (
        <PasswordPrompt download={promptDownload} onDismiss={handleDismissPasswordPrompt} />
      ) : null}
      {settingsOpen && outputFolder !== undefined ? (
        <SettingsPanel
          outputFolder={outputFolder}
          onOutputFolderChange={setOutputFolder}
          debugMode={debugMode}
          onDebugModeChange={setDebugMode}
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
