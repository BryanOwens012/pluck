import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DebugLogEvent,
  type Download,
  type FormatChoice,
  type PlaylistContext,
  type PlaylistOrder,
  STATIC_FORMAT_CHOICES,
  STATIC_FORMAT_CHOICES_ORDERED,
} from '../../shared/types';
import { isHttpUrl, looksLikePlaylistUrl } from '../../shared/url';
import { DownloadQueue } from './components/DownloadQueue';
import { FormatSelector } from './components/FormatSelector';
import { PasswordPrompt } from './components/PasswordPrompt';
import { PlaylistPrompt } from './components/PlaylistPrompt';
import { SettingsPanel } from './components/SettingsPanel';
import { UrlInput } from './components/UrlInput';
import { useDebouncedValue } from './hooks/useDebouncedValue';
import { api } from './lib/api';

/** Per-download log buffer cap. Debug mode for one long Zoom recording
 * shouldn't balloon renderer memory — we drop the oldest lines when
 * the buffer hits this size. 500 lines is roughly 8-10 minutes of
 * throttled progress + scattered yt-dlp chatter. */
const MAX_LOG_LINES_PER_ID = 500;

/** Trailing-edge wait before firing the per-URL format probe. Just
 * long enough to coalesce a burst of keystrokes into a single IPC
 * (avoids spawning yt-dlp once per character if the user is typing
 * a URL manually) — short enough that a paste feels instant. */
const FORMAT_PROBE_DEBOUNCE_MS = 100;

/** Single-entry placeholder shown the instant a URL becomes valid,
 * before the metadata probe has resolved. The user can still click
 * Download and gets the static "best" args (mp4-preferring, av1-
 * excluded) — yt-dlp picks the right stream without us needing the
 * probe result. We show the full static-preset list so the user can
 * immediately pick a specific tier (e.g., 720p for a bandwidth save)
 * without waiting on the probe. Only the "Best" entry gets a "(TBD)"
 * suffix because we don't know the actual top resolution yet — the
 * other tiers' labels already say their height. Each preset's
 * `ytDlpFormatArgs` selects the highest mp4 ≤ its tier height, so
 * clicking "720p" before the probe lands still produces the right
 * file. The dropdown swaps in enriched + deduplicated choices when
 * the probe resolves. */
const PROBING_PLACEHOLDER_CHOICES: readonly FormatChoice[] = [
  { ...STATIC_FORMAT_CHOICES.best, label: 'Best (TBD)' },
  STATIC_FORMAT_CHOICES['1080p'],
  STATIC_FORMAT_CHOICES['720p'],
  STATIC_FORMAT_CHOICES['480p'],
  STATIC_FORMAT_CHOICES['360p'],
  STATIC_FORMAT_CHOICES.audio_mp3,
];

const VIEWS = ['main', 'settings'] as const;
type View = (typeof VIEWS)[number];

const App = (): React.JSX.Element => {
  // Keyed by Download.id so push updates replace by id; rendered as a list
  // sorted by createdAt descending (newest first). One state owner, one
  // consumer (DownloadQueue) — no need for a global store yet.
  const [downloads, setDownloads] = useState<Map<string, Download>>(() => new Map());
  // Currently-selected FormatChoice. Default to the static "Best
  // quality" entry; the URL-change effect below resets it to the
  // PROBING_PLACEHOLDER on every fresh URL, and the probe-completion
  // effect swaps it for the matching id from the real choice list when
  // the IPC returns.
  const [format, setFormat] = useState<FormatChoice>(STATIC_FORMAT_CHOICES.best);
  // Available choices for the dropdown. Three phases:
  //   - URL empty / invalid: STATIC_FORMAT_CHOICES_ORDERED (dropdown
  //     itself is hidden, but render-ready in case validity flips).
  //   - URL valid, probe in flight: PROBING_PLACEHOLDER_CHOICES (a
  //     single "Best (TBD)" entry so the user can click Download
  //     immediately without waiting on the probe).
  //   - Probe landed: the enriched per-URL list (4 defaults with
  //     shorthand on 'best', dedupe of any tier matching best's
  //     shorthand, optional 5th `best_alt` for non-mp4 alternatives).
  const [formatChoices, setFormatChoices] = useState<readonly FormatChoice[]>(
    STATIC_FORMAT_CHOICES_ORDERED,
  );
  // Raw URL input value. Owned here (not inside UrlInput) so we can
  // derive `urlIsValid` synchronously and hide the Download button +
  // FormatSelector until a real URL is present. Debounced separately
  // below for the format-probe IPC.
  const [url, setUrl] = useState('');
  const trimmedUrl = url.trim();
  const urlIsValid = isHttpUrl(trimmedUrl);
  const debouncedUrl = useDebouncedValue(urlIsValid ? trimmedUrl : '', FORMAT_PROBE_DEBOUNCE_MS);
  // Settings snapshot. Loaded once on mount and refreshed after a save
  // from SettingsPanel. The folder picker lives inside Settings now;
  // App keeps the value so startDownload doesn't need to re-fetch.
  const [outputFolder, setOutputFolder] = useState<string | undefined>(undefined);
  const [debugMode, setDebugMode] = useState(false);
  // Two-pane navigation. Keeping it as a simple discriminated state on
  // App is enough — no need for a routing library for a two-view app.
  // Switching to 'settings' doesn't unmount the download queue; the
  // map of downloads keeps living here, so progress pushes from main
  // continue updating even while the user is on the Settings page.
  const [view, setView] = useState<View>('main');
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

  // Reset the dropdown to the single-option "Best (TBD)" placeholder
  // the instant the URL changes to a valid one. Sync, off the raw
  // (non-debounced) URL so the dropdown reflects the paste immediately
  // and the user can click Download without waiting on the probe.
  // `trimmedUrl` is included in deps even though the body doesn't read
  // it directly: switching from valid URL A to valid URL B must re-run
  // the effect so the placeholder kicks in for the new URL instead of
  // leaving stale enriched choices from A on screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trimmedUrl drives re-fires intentionally
  useEffect(() => {
    if (!urlIsValid) {
      setFormatChoices(STATIC_FORMAT_CHOICES_ORDERED);
      return;
    }
    setFormatChoices(PROBING_PLACEHOLDER_CHOICES);
    const placeholder = PROBING_PLACEHOLDER_CHOICES[0];
    if (placeholder !== undefined) {
      setFormat(placeholder);
    }
  }, [trimmedUrl, urlIsValid]);

  // Currently-known playlist context for the URL the user is typing.
  // Populated by the format-probe IPC alongside the choices; undefined
  // for plain single-video URLs. Used to decide whether to pop the
  // PlaylistPrompt modal when the user clicks Download.
  const [playlistContext, setPlaylistContext] = useState<PlaylistContext | undefined>(undefined);
  // Pending prompt — the format the user picked (the modal commits a
  // FormatChoice + URL to either the single-download IPC or the
  // playlist-enumerate-then-enqueue IPC). When non-null, the modal is
  // visible. Reset to null on resolve / dismiss.
  const [pendingPlaylistPrompt, setPendingPlaylistPrompt] = useState<
    { context: PlaylistContext | undefined; url: string; format: FormatChoice } | undefined
  >(undefined);
  // Enumerations in flight — set when the user picks "All videos" so the
  // queue can render a placeholder accordion right away (yt-dlp -J
  // --flat-playlist takes 5-10 s; without the placeholder the page
  // appears unresponsive). Each entry is removed in the IPC chain's
  // `finally` — either when the real rows have been enqueued (success)
  // or when enumerate fails (so the placeholder doesn't orphan). Keyed
  // by a renderer-side id so multiple simultaneous enumerations each
  // get their own placeholder.
  const [pendingEnumerations, setPendingEnumerations] = useState<
    { id: string; context: PlaylistContext | undefined }[]
  >([]);

  // Per-URL format probe. Driven off the debounced URL so we don't IPC
  // on every keystroke. The IPC handler shares the metadataCache with
  // UrlInput's prefetch warm, so this is typically a cache hit (free).
  // When choices land, we preserve selection by id — usually the user
  // is still on 'best' from the placeholder, which maps cleanly to the
  // probed 'best' choice. We also pick up the playlist context here so
  // a Download click can pop the modal without an extra IPC round-trip.
  useEffect(() => {
    if (debouncedUrl.length === 0) {
      setPlaylistContext(undefined);
      return;
    }
    let cancelled = false;
    api
      .getFormatChoices(debouncedUrl)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setPlaylistContext(result.playlistContext);
        if (result.choices.length === 0) {
          return;
        }
        setFormatChoices(result.choices);
        setFormat(
          (prev) => result.choices.find((c) => c.id === prev.id) ?? result.choices[0] ?? prev,
        );
      })
      .catch((err: unknown) => {
        console.error('getFormatChoices rejected:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedUrl]);

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

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!urlIsValid) {
      return;
    }
    // Playlist branch: hold off enqueuing and pop the prompt. The
    // modal's callbacks dispatch to either the single-video path
    // (--no-playlist semantics — same IPC, the user just doesn't
    // want the playlist) or the enumerate-then-enqueue path. We
    // snapshot the format + URL on the pending prompt so re-fetches
    // mid-prompt don't change what gets enqueued.
    //
    // Trigger on EITHER the resolved playlistContext (probe has
    // landed) OR a sync URL-shape match (probe still in flight). The
    // latter handles the common "paste then immediately click
    // Download" race — the probe takes a few seconds, but the modal
    // should pop the moment the click happens. The enumerate IPC the
    // "All videos" path triggers will fill in the title/count
    // authoritatively.
    if (playlistContext || looksLikePlaylistUrl(trimmedUrl)) {
      setPendingPlaylistPrompt({ context: playlistContext, url: trimmedUrl, format });
      setUrl('');
      return;
    }
    api.startDownload({ url: trimmedUrl, format }).catch((err: unknown) => {
      console.error('startDownload rejected:', err);
    });
    setUrl('');
  };

  const handlePlaylistJustOne = (): void => {
    if (!pendingPlaylistPrompt) {
      return;
    }
    const { url: pendingUrl, format: pendingFormat } = pendingPlaylistPrompt;
    setPendingPlaylistPrompt(undefined);
    api.startDownload({ url: pendingUrl, format: pendingFormat }).catch((err: unknown) => {
      console.error('startDownload rejected:', err);
    });
  };

  const handlePlaylistWhole = (order: PlaylistOrder): void => {
    if (!pendingPlaylistPrompt) {
      return;
    }
    const { url: pendingUrl, format: pendingFormat, context } = pendingPlaylistPrompt;
    setPendingPlaylistPrompt(undefined);

    // Push a placeholder onto the pending-enumerations list BEFORE
    // firing the enumerate IPC. The DownloadQueue renders a
    // PlaylistGroupPlaceholder for each pending entry — gives the user
    // instant feedback that their click registered, instead of staring
    // at an empty queue for the 5-10 s `yt-dlp -J --flat-playlist` run.
    // The entry is cleared in `finally`, by which time either the real
    // rows have shown up in the queue (success) or the enumerate
    // bailed (failure / no entries).
    const enumerationId = crypto.randomUUID();
    setPendingEnumerations((prev) => [...prev, { id: enumerationId, context }]);

    api
      .enumeratePlaylist(pendingUrl)
      .then((result) => {
        if (!result.ok) {
          console.error('enumeratePlaylist returned no entries', result);
          return;
        }
        const resolvedContext = result.context ?? context;
        if (result.entries.length === 0 || !resolvedContext) {
          console.error('enumeratePlaylist returned no entries', result);
          return;
        }
        return api.startPlaylistDownload({
          entries: result.entries,
          format: pendingFormat,
          playlistContext: resolvedContext,
          order,
        });
      })
      .catch((err: unknown) => {
        console.error('playlist enqueue rejected:', err);
      })
      .finally(() => {
        setPendingEnumerations((prev) => prev.filter((e) => e.id !== enumerationId));
      });
  };

  // Stable so SettingsPanel's window-level Esc listener doesn't
  // attach/detach on every App render. App re-renders multiple times
  // per second during an active download (progress pushes), and Esc
  // is what closes Settings — we don't want to be re-binding the
  // listener that often.
  const handleBackToMain = useCallback((): void => {
    setView('main');
  }, []);

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
      {view === 'settings' && outputFolder !== undefined ? (
        <SettingsPanel
          outputFolder={outputFolder}
          onOutputFolderChange={setOutputFolder}
          debugMode={debugMode}
          onDebugModeChange={setDebugMode}
          onBack={handleBackToMain}
        />
      ) : (
        <div className="mx-auto max-w-2xl space-y-4 p-6">
          <header className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">Pluck</h1>
            <button
              type="button"
              onClick={() => setView('settings')}
              aria-label="Open settings"
              title="Settings"
              className="rounded p-1.5 text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100"
            >
              <GearIcon />
            </button>
          </header>
          <form onSubmit={handleSubmit} className="space-y-2">
            <UrlInput value={url} onChange={setUrl} />
            {urlIsValid ? (
              <div className="flex gap-2">
                <FormatSelector
                  value={format}
                  onChange={setFormat}
                  choices={formatChoices}
                  debugMode={debugMode}
                />
                <button
                  type="submit"
                  className="flex-1 rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white"
                >
                  Download
                </button>
              </div>
            ) : null}
          </form>
          <DownloadQueue
            rows={rows}
            pendingEnumerations={pendingEnumerations}
            onOpenPasswordPrompt={handleOpenPasswordPrompt}
            debugMode={debugMode}
            debugLogs={debugLogs}
          />
        </div>
      )}
      {/* Password prompt is a JIT interrupt, not navigation — stays a
          modal that floats over whichever view is active. */}
      {promptDownload ? (
        <PasswordPrompt download={promptDownload} onDismiss={handleDismissPasswordPrompt} />
      ) : null}
      {/* Playlist prompt — same modal pattern, fires when the user
          clicks Download on a URL whose metadata had a playlist
          context. The three buttons dispatch to either single-video
          or whole-playlist (in either order) enqueue. */}
      {pendingPlaylistPrompt ? (
        <PlaylistPrompt
          context={pendingPlaylistPrompt.context}
          onJustOne={handlePlaylistJustOne}
          onWholePlaylist={handlePlaylistWhole}
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
