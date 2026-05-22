import { useCallback, useEffect, useState } from 'react';
import type { SecretName } from '../../../main/secrets';
import type { Settings } from '../../../main/settings';
import {
  ANTHROPIC_ENABLED,
  ANY_AI_PROVIDER_ENABLED,
  ELEVENLABS_ENABLED,
} from '../../../shared/flags';
import { BROWSER_NAMES, type BrowserName, type ExtractedFlags } from '../../../shared/types';
import { api } from '../lib/api';
import { OutputFolderPicker } from './OutputFolderPicker';

type Props = {
  /** Current persisted output folder. Comes from App's state so the
   * picker inside Settings shows the same value as the row picker. */
  outputFolder: string;
  /** Called when the output folder changes (picker bubble-up). */
  onOutputFolderChange: (next: string) => void;
  /** Current debug-mode flag. App owns it so DownloadQueue + main
   * stay in sync without each component re-fetching settings. */
  debugMode: boolean;
  /** Called when the user toggles debug mode in the Developer section. */
  onDebugModeChange: (next: boolean) => void;
  /** Current transcription-enabled flag — gates the Transcribe button
   * on completed Download rows. */
  transcriptionEnabled: boolean;
  /** Called when the user toggles transcription in the API keys section. */
  onTranscriptionEnabledChange: (next: boolean) => void;
  /** Called when the user clicks the back arrow or presses Esc. App
   * flips its view state back to 'main'. */
  onBack: () => void;
};

/** Full-page Settings view. Replaces the main download UI when the
 * user clicks the gear icon — no backdrop, no modal scaffolding. The
 * back arrow + Esc both return to main. Esc is wired via a window-
 * level keydown listener (not the page div) so it fires regardless
 * of which focusable child is active. */
export const SettingsPanel = ({
  outputFolder,
  onOutputFolderChange,
  debugMode,
  onDebugModeChange,
  transcriptionEnabled,
  onTranscriptionEnabledChange,
  onBack,
}: Props): React.JSX.Element => {
  // Override is hoisted here so the dependent rows (cookies, concurrent
  // fragments) can render disabled with the extracted value when an
  // override is active. We load it from settings on mount and re-parse
  // (via main) whenever the OverrideRow saves a new value.
  const [overrideExtracted, setOverrideExtracted] = useState<ExtractedFlags | undefined>(undefined);

  useEffect(() => {
    api
      .getSettings()
      .then(async (s) => {
        if (!s.ytDlpCommandOverride) {
          setOverrideExtracted(undefined);
          return;
        }
        const parsed = await api.parseYtDlpCommand(s.ytDlpCommandOverride);
        setOverrideExtracted(parsed.ok ? parsed.extracted : undefined);
      })
      .catch((err: unknown) => {
        console.error('settings boot: override read rejected:', err);
      });
  }, []);

  const handleOverrideExtractedChange = useCallback((next: ExtractedFlags | undefined): void => {
    setOverrideExtracted(next);
  }, []);

  // Window-level Esc → back. Attached to window (not the page div)
  // so the keypress fires regardless of which control inside has
  // focus. Cleaned up when the page unmounts (i.e. on view switch).
  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onBack();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
    };
  }, [onBack]);

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="mx-auto max-w-2xl space-y-6 p-6">
        <header className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to downloads"
            title="Back"
            className="rounded p-1.5 text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-100"
          >
            <BackIcon />
          </button>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Settings</h1>
        </header>
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Default output folder
          </h3>
          <OutputFolderPicker outputFolder={outputFolder} onChange={onOutputFolderChange} />
        </section>
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Browser cookies
          </h3>
          <CookiesSection overrideExtracted={overrideExtracted} />
        </section>
        {ANY_AI_PROVIDER_ENABLED ? (
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              API keys
            </h3>
            <p className="text-xs text-neutral-500">
              Optional. Pluck will prompt you the first time a feature needs a key.
            </p>
            {ELEVENLABS_ENABLED ? (
              <>
                <ApiKeyRow
                  provider="elevenlabs"
                  label="ElevenLabs"
                  help="Powers transcription (Transcribe button on completed downloads)."
                />
                <TranscriptionToggleRow
                  transcriptionEnabled={transcriptionEnabled}
                  onChange={onTranscriptionEnabledChange}
                />
              </>
            ) : null}
            {ANTHROPIC_ENABLED ? (
              <ApiKeyRow
                provider="anthropic"
                label="Anthropic"
                help="Powers AI prompt suggestions (coming soon)."
              />
            ) : null}
          </section>
        ) : null}
        <DeveloperSection
          debugMode={debugMode}
          onDebugModeChange={onDebugModeChange}
          overrideExtracted={overrideExtracted}
          onOverrideExtractedChange={handleOverrideExtractedChange}
        />
        <VersionFooter />
      </div>
    </div>
  );
};

/** Lucide-style back arrow. Inlined so we don't pull a full icon dep
 * for a one-off page navigation affordance. */
const BackIcon = (): React.JSX.Element => (
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
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </svg>
);

/** Collapsible Developer section. Closed by default; the open/closed
 * state persists in `Settings.developerSectionOpen` so a power user
 * who's been poking at debug flags doesn't have to re-open it every
 * launch. When closed, the inner rows are unmounted — their
 * useEffects (settings fetches, browser detection, override boot)
 * don't fire until the user expands the section, so the casual-user
 * Settings open stays fast and side-effect free. */
const DeveloperSection = ({
  debugMode,
  onDebugModeChange,
  overrideExtracted,
  onOverrideExtractedChange,
}: {
  debugMode: boolean;
  onDebugModeChange: (next: boolean) => void;
  overrideExtracted: ExtractedFlags | undefined;
  onOverrideExtractedChange: (next: ExtractedFlags | undefined) => void;
}): React.JSX.Element => {
  // `open` mirrors the persisted value. We initialize from
  // api.getSettings() on mount; until that resolves we render closed
  // (the safer default — avoids a flash-of-open).
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setOpen(s.developerSectionOpen);
      })
      .catch((err: unknown) => {
        console.error('developer section boot rejected:', err);
      });
  }, []);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    api.updateSettings({ developerSectionOpen: next }).catch((err: unknown) => {
      console.error('updateSettings(developerSectionOpen) rejected:', err);
      // Revert on save failure so the persisted state matches the UI.
      setOpen(!next);
    });
  };

  return (
    <section className="space-y-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md py-1 text-left transition hover:bg-neutral-900"
      >
        <ChevronRightIcon
          className={`h-3 w-3 text-neutral-500 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Developer</h3>
      </button>
      {/* Inner rows are conditionally rendered — when closed, their
          useEffects don't fire (no IPC traffic for users who never
          open this section). */}
      {open ? (
        <div className="space-y-2">
          <DebugModeRow debugMode={debugMode} onChange={onDebugModeChange} />
          <YtDlpUpdaterRow />
          <ConcurrentDownloadsRow />
          <ConcurrentFragmentsRow overrideExtracted={overrideExtracted} />
          <YtDlpCommandOverrideRow onExtractedChange={onOverrideExtractedChange} />
          <ClearTempFoldersRow />
        </div>
      ) : null}
    </section>
  );
};

/** Lucide-style right-pointing chevron, used by the Developer section
 * accordion header. Rotated 90deg via a className when open. */
const ChevronRightIcon = ({ className }: { className?: string }): React.JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
);

/** Per-feature opt-in toggle for transcription. Lives in the API
 * keys section right under the ElevenLabs row because the UX flow
 * is read top-to-bottom: save the ElevenLabs key, then flip this
 * toggle, then the Transcribe button appears on every completed
 * download. Default off so a freshly-saved key doesn't immediately
 * surface a new button without an explicit user opt-in. */
const TranscriptionToggleRow = ({
  transcriptionEnabled,
  onChange,
}: {
  transcriptionEnabled: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element => {
  const handleToggle = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.checked;
    onChange(next);
    // Optimistic update — App's state flips immediately, the save
    // happens in the background. Revert on error so the toggle stays
    // truthful to disk.
    api.updateSettings({ transcriptionEnabled: next }).catch((err: unknown) => {
      console.error('updateSettings transcriptionEnabled rejected:', err);
      onChange(!next);
    });
  };

  return (
    <label className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <input
        type="checkbox"
        checked={transcriptionEnabled}
        onChange={handleToggle}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-neutral-100"
      />
      <span className="min-w-0 flex-1 text-xs">
        <span className="block font-medium text-neutral-200">Enable transcription</span>
        <span className="block text-neutral-500">
          Show a Transcribe button on completed downloads. Click to extract audio, send it to
          ElevenLabs, and write an <code className="text-neutral-400">.srt</code> next to the video.
          Requires the ElevenLabs key above.
        </span>
      </span>
    </label>
  );
};

// ---- developer section ----------------------------------------------

const DebugModeRow = ({
  debugMode,
  onChange,
}: {
  debugMode: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element => {
  const handleToggle = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.checked;
    onChange(next);
    // Optimistic UI: App's state flips immediately, the save happens
    // in the background. On error we revert.
    api.updateSettings({ debugMode: next }).catch((err: unknown) => {
      console.error('updateSettings debugMode rejected:', err);
      onChange(!next);
    });
  };

  return (
    <label className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <input
        type="checkbox"
        checked={debugMode}
        onChange={handleToggle}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-neutral-100"
      />
      <span className="min-w-0 flex-1 text-xs">
        <span className="block font-medium text-neutral-200">Debug mode</span>
        <span className="block text-neutral-500">
          Show a live log of yt-dlp activity under each download, plus a folder button to inspect
          its temp directory. Failed downloads in debug mode keep their temp folder for inspection.
        </span>
      </span>
    </label>
  );
};

// Concurrency dial bounds. Source of truth is main/settings.ts; the
// renderer mirrors them so the dropdown can populate without an IPC
// round-trip. Kept in sync manually — change both places together.
const MIN_CONCURRENT_FRAGMENTS = 1;
const MAX_CONCURRENT_FRAGMENTS = 20;
const DEFAULT_CONCURRENT_FRAGMENTS = 14;
const MIN_CONCURRENT_DOWNLOADS = 1;
const MAX_CONCURRENT_DOWNLOADS = 10;
const DEFAULT_CONCURRENT_DOWNLOADS = 3;

const CONCURRENCY_KEYS = ['concurrentFragments', 'concurrentDownloads'] as const;
type ConcurrencyKey = (typeof CONCURRENCY_KEYS)[number];

type ConcurrencyRowProps = {
  settingKey: ConcurrencyKey;
  label: string;
  description: string;
  min: number;
  max: number;
  initialDefault: number;
  /** Extracted flags from an active yt-dlp command override. When
   * defined (object present, even if empty), the row locks because
   * the override controls what runs — the saved setting won't take
   * effect. If the row's flag is pinned, its value is what we show;
   * otherwise we fall back to the saved value with the lock hint. */
  overrideExtracted?: ExtractedFlags;
};

/** Shared scaffold for the two concurrency dropdowns. Both load from
 * settings, optimistic-save on change, revert + show error on failure.
 * Extracted because the two rows are mechanically identical apart
 * from the setting key and copy. */
const ConcurrencyRow = ({
  settingKey,
  label,
  description,
  min,
  max,
  initialDefault,
  overrideExtracted,
}: ConcurrencyRowProps): React.JSX.Element => {
  const [value, setValue] = useState<number>(initialDefault);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setValue(s[settingKey]);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        console.error('getSettings rejected:', err);
        setLoaded(true);
      });
  }, [settingKey]);

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = Number.parseInt(event.target.value, 10);
    const prev = value;
    setValue(next);
    setError(undefined);
    api.updateSettings({ [settingKey]: next }).catch((err: unknown) => {
      console.error('updateSettings rejected:', err);
      setValue(prev);
      setError('Failed to save.');
    });
  };

  const options = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  // Lock whenever an override is active (the saved value won't take
  // effect — yt-dlp runs whatever the override says). When the override
  // pins this row's flag, surface the parsed value; otherwise fall back
  // to the saved value so the row stays readable.
  const overridden = overrideExtracted !== undefined;
  const overrideForThisRow =
    settingKey === 'concurrentFragments' ? overrideExtracted?.concurrentFragments : undefined;
  const displayValue = overrideForThisRow ?? (loaded ? value : initialDefault);

  return (
    <div className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-neutral-200">{label}</div>
          <div className="text-xs text-neutral-500">{description}</div>
        </div>
        <select
          value={displayValue}
          onChange={handleChange}
          disabled={!loaded || overridden}
          className="shrink-0 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-50"
        >
          {options.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {overridden ? (
        <p className="text-xs text-neutral-500">
          Locked by yt-dlp command override in Developer settings.
        </p>
      ) : null}
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  );
};

const ConcurrentFragmentsRow = ({
  overrideExtracted,
}: {
  overrideExtracted?: ExtractedFlags;
}): React.JSX.Element => (
  <ConcurrencyRow
    settingKey="concurrentFragments"
    label="Concurrent fragments"
    description={`yt-dlp's -N flag (parallel chunks per single download). Higher = faster, but can trip per-server rate limits. Default ${DEFAULT_CONCURRENT_FRAGMENTS}.`}
    min={MIN_CONCURRENT_FRAGMENTS}
    max={MAX_CONCURRENT_FRAGMENTS}
    initialDefault={DEFAULT_CONCURRENT_FRAGMENTS}
    overrideExtracted={overrideExtracted}
  />
);

const ConcurrentDownloadsRow = (): React.JSX.Element => (
  <ConcurrencyRow
    settingKey="concurrentDownloads"
    label="Concurrent downloads"
    description={`How many downloads run at once. The rest wait in 'Queued' until a slot opens. Default ${DEFAULT_CONCURRENT_DOWNLOADS}.`}
    min={MIN_CONCURRENT_DOWNLOADS}
    max={MAX_CONCURRENT_DOWNLOADS}
    initialDefault={DEFAULT_CONCURRENT_DOWNLOADS}
  />
);

type ClearState =
  | { phase: 'idle' }
  | { phase: 'clearing' }
  | { phase: 'done'; cleared: number; skippedActive: number }
  | { phase: 'error'; message: string };

type OverrideRowProps = {
  /** Bubbled-up extracted flags from a successful parse — undefined
   * when the field is empty (auto mode) or the contents fail to
   * parse (the row shows the error inline; the override is treated
   * as inactive by the rest of Settings until the user fixes it). */
  onExtractedChange: (next: ExtractedFlags | undefined) => void;
};

/** Free-input override of the yt-dlp command. Empty = auto mode and the
 * row displays a read-only preview of the command Pluck would build
 * from the other settings. Non-empty = override; the row's text takes
 * precedence at download time. The other dependent rows (cookies,
 * concurrent fragments) read their values out of this override and
 * gray themselves out. */
const YtDlpCommandOverrideRow = ({ onExtractedChange }: OverrideRowProps): React.JSX.Element => {
  const [text, setText] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [parseError, setParseError] = useState<string | undefined>(undefined);
  const [autoPreview, setAutoPreview] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  // Initial load: read the persisted override + the would-be-run
  // auto preview so the user has a baseline to see.
  useEffect(() => {
    Promise.all([api.getSettings(), api.getInvocationPreview()])
      .then(([s, preview]) => {
        const value = s.ytDlpCommandOverride ?? '';
        setText(value);
        setAutoPreview(preview);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        console.error('override row boot rejected:', err);
        setLoaded(true);
      });
  }, []);

  // Re-parse on every text edit so the user gets immediate feedback on
  // unbalanced quotes / first-token mismatches. The parse output also
  // drives the parent's gray-out state, so it has to be live.
  useEffect(() => {
    if (!loaded) {
      return;
    }
    if (text.trim().length === 0) {
      setParseError(undefined);
      onExtractedChange(undefined);
      return;
    }
    let cancelled = false;
    api
      .parseYtDlpCommand(text)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setParseError(undefined);
          onExtractedChange(result.extracted);
        } else {
          setParseError(result.error);
          // Treat a broken override as inactive — gray-out should
          // turn off so the user can still drive the dependent rows
          // via Settings while they're fixing the override.
          onExtractedChange(undefined);
        }
      })
      .catch((err: unknown) => {
        console.error('parseYtDlpCommand rejected:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [text, loaded, onExtractedChange]);

  const persist = (next: string): void => {
    setSaving(true);
    setSaveError(undefined);
    api
      .updateSettings({ ytDlpCommandOverride: next })
      .then(() => api.getInvocationPreview())
      .then((preview) => {
        setAutoPreview(preview);
        setSaving(false);
      })
      .catch((err: unknown) => {
        console.error('updateSettings(ytDlpCommandOverride) rejected:', err);
        setSaving(false);
        setSaveError('Failed to save.');
      });
  };

  const handleBlur = (): void => {
    if (!loaded) {
      return;
    }
    persist(text);
  };

  const isEmpty = text.trim().length === 0;

  return (
    <div className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="text-xs font-medium text-neutral-200">yt-dlp command</div>
      <div className="text-xs text-neutral-500">
        Leave empty to let Pluck build the command from your other settings. Type a complete command
        (starting with <code className="rounded bg-neutral-800 px-1 py-px">yt-dlp</code>) to
        override it. Use <code className="rounded bg-neutral-800 px-1 py-px">&lt;URL&gt;</code> as a
        placeholder for the video URL; otherwise it's appended at the end.
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={handleBlur}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={isEmpty ? autoPreview || 'yt-dlp <flags> <URL>' : undefined}
        rows={4}
        className="w-full resize-y rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 font-mono text-[11px] leading-snug text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
      />
      {parseError ? <p className="text-xs text-red-400">{parseError}</p> : null}
      {saveError ? <p className="text-xs text-red-400">{saveError}</p> : null}
      {isEmpty && !parseError ? (
        <p className="text-xs text-neutral-500">
          {saving ? 'Saving…' : `Auto mode — Pluck will run: ${autoPreview}`}
        </p>
      ) : null}
    </div>
  );
};

/** Phase-tagged state for the yt-dlp updater row. `idle` is the
 * pre-mount placeholder; the boot useEffect immediately calls
 * `api.getYtDlpStatus()` and flips to `loaded`. `checking` /
 * `installing` are the in-flight states for the two manual buttons.
 * After install completes we hold the result in `installed` so the
 * UI can surface "Restart Pluck to use vX.Y.Z" until the user
 * acts. Discriminated union (rather than the const-array string-
 * union pattern) because each phase carries different payload. */
type YtDlpUpdaterState =
  | { phase: 'idle' }
  | {
      phase: 'loaded';
      installedVersion: string | undefined;
      source: 'bundled' | 'auto-updated';
      /** Set when the most recent `checkForUpdate` call returned an
       * `error` string (network down, GitHub 5xx). The status line
       * appends "Last check failed: …" so the user can tell a
       * checked-OK-no-update from a couldn't-check-at-all. */
      checkError?: string;
    }
  | {
      phase: 'checking';
      installedVersion: string | undefined;
      source: 'bundled' | 'auto-updated';
    }
  | {
      phase: 'install-prompt';
      installedVersion: string | undefined;
      source: 'bundled' | 'auto-updated';
      latestVersion: string;
      checkedAt: number;
      checkError?: string;
    }
  | {
      phase: 'installing';
      installedVersion: string | undefined;
      source: 'bundled' | 'auto-updated';
      latestVersion: string;
    }
  | { phase: 'installed'; newVersion: string }
  | { phase: 'install-failed'; error: string };

/** Developer-accordion row for yt-dlp: shows the current version +
 * source (bundled / auto-updated), the auto-update toggle, a
 * "Check now" button, and an inline "Update available — Install"
 * affordance when GitHub reports a newer build. After a successful
 * install the row shows a "restart to apply" notice; the new
 * binary takes effect on the next app launch (the current session
 * keeps using whatever was captured at boot). */
const YtDlpUpdaterRow = (): React.JSX.Element => {
  const [state, setState] = useState<YtDlpUpdaterState>({ phase: 'idle' });
  const [autoUpdate, setAutoUpdate] = useState<boolean>(true);

  // Boot: read the current installation (cheap, sub-second) +
  // pull the persisted auto-update flag. Don't kick off the
  // GitHub check automatically — main does that at app launch
  // when the toggle is on; the user can hit "Check now" if they
  // want a fresh status mid-session.
  useEffect(() => {
    let cancelled = false;
    api
      .getYtDlpStatus()
      .then((status) => {
        if (cancelled) {
          return;
        }
        setState({
          phase: 'loaded',
          installedVersion: status.version,
          source: status.source,
        });
      })
      .catch((err: unknown) => {
        console.error('getYtDlpStatus rejected:', err);
      });
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) {
          setAutoUpdate(s.ytDlpAutoUpdate);
        }
      })
      .catch((err: unknown) => {
        console.error('getSettings rejected:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoUpdateToggle = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = event.target.checked;
    setAutoUpdate(next);
    api.updateSettings({ ytDlpAutoUpdate: next }).catch((err: unknown) => {
      console.error('updateSettings ytDlpAutoUpdate rejected:', err);
      setAutoUpdate(!next);
    });
  };

  const handleCheck = async (): Promise<void> => {
    // The button is disabled during 'checking' / 'installing', so
    // those phases shouldn't reach here; defend just in case React
    // batches a stale onClick. From 'installed' / 'install-failed'
    // we DO want to allow re-checking — the user may want to
    // verify before / after the restart they've been prompted to
    // do — so we transition straight back into 'checking'
    // carrying whatever installed version we last knew about.
    if (state.phase === 'checking' || state.phase === 'installing') {
      return;
    }
    const carriedVersion = 'installedVersion' in state ? state.installedVersion : undefined;
    const carriedSource = 'source' in state ? state.source : 'bundled';
    setState({
      phase: 'checking',
      installedVersion: carriedVersion,
      source: carriedSource,
    });
    const result = await api.checkYtDlpUpdate();
    if (result.updateAvailable && result.latestVersion !== undefined) {
      setState({
        phase: 'install-prompt',
        installedVersion: result.current.version,
        source: result.current.source,
        latestVersion: result.latestVersion,
        checkedAt: result.checkedAt,
        checkError: result.error,
      });
    } else {
      // Either up-to-date or the check failed. Stay in `loaded`;
      // surface any error in a subtitle so the user can tell a
      // "checked OK, no update" from a "couldn't check at all".
      setState({
        phase: 'loaded',
        installedVersion: result.current.version,
        source: result.current.source,
        checkError: result.error,
      });
    }
  };

  const handleInstall = async (): Promise<void> => {
    if (state.phase !== 'install-prompt') {
      return;
    }
    setState({
      phase: 'installing',
      installedVersion: state.installedVersion,
      source: state.source,
      latestVersion: state.latestVersion,
    });
    const result = await api.installYtDlpUpdate();
    if (result.ok) {
      setState({ phase: 'installed', newVersion: state.latestVersion });
    } else {
      setState({ phase: 'install-failed', error: result.error });
    }
  };

  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-neutral-200">yt-dlp</div>
          <div className="mt-0.5 break-words text-xs text-neutral-500">
            <YtDlpStatusLine state={state} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.phase === 'install-prompt' ? (
            <button
              type="button"
              onClick={() => {
                void handleInstall();
              }}
              className="rounded-md border border-sky-900/70 bg-sky-950/40 px-2 py-0.5 text-xs font-medium text-sky-300 transition hover:bg-sky-900/50 hover:text-sky-200"
            >
              Install update
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              void handleCheck();
            }}
            disabled={state.phase === 'checking' || state.phase === 'installing'}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-medium text-neutral-200 transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-neutral-900"
          >
            {state.phase === 'checking' ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={autoUpdate}
          onChange={handleAutoUpdateToggle}
          className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-neutral-100"
        />
        <span className="text-xs text-neutral-400">
          Auto-update on launch — checks GitHub for a newer yt-dlp release each time the app starts.
          New versions take effect on the next launch.
        </span>
      </label>
    </div>
  );
};

/** One-line status sentence under the "yt-dlp" header that reads
 * differently in each phase. Extracted so the row's render stays
 * legible — the seven phases would otherwise create a wall of
 * ternaries inline. */
const YtDlpStatusLine = ({ state }: { state: YtDlpUpdaterState }): React.JSX.Element => {
  if (state.phase === 'idle') {
    return <span>Loading…</span>;
  }
  if (state.phase === 'checking') {
    return (
      <span>
        <CurrentVersionLabel installedVersion={state.installedVersion} source={state.source} /> ·
        Checking <YtDlpRepoLink>GitHub</YtDlpRepoLink>…
      </span>
    );
  }
  if (state.phase === 'installing') {
    return (
      <span>
        <CurrentVersionLabel installedVersion={state.installedVersion} source={state.source} /> ·
        Installing {state.latestVersion}…
      </span>
    );
  }
  if (state.phase === 'install-prompt') {
    return (
      <span>
        <CurrentVersionLabel installedVersion={state.installedVersion} source={state.source} /> ·{' '}
        <span className="text-sky-400">Update available — {state.latestVersion}</span>
        {state.checkError ? (
          <span className="block text-red-400">Last check failed: {state.checkError}</span>
        ) : null}
      </span>
    );
  }
  if (state.phase === 'installed') {
    return (
      <span className="text-emerald-400">
        Installed {state.newVersion}. Restart Pluck to use the new version.
      </span>
    );
  }
  if (state.phase === 'install-failed') {
    return <span className="text-red-400">Install failed: {state.error}</span>;
  }
  // phase === 'loaded'
  return (
    <span>
      <CurrentVersionLabel installedVersion={state.installedVersion} source={state.source} />
      {state.checkError ? (
        <span className="block text-red-400">Last check failed: {state.checkError}</span>
      ) : null}
    </span>
  );
};

/** Inline link that opens the yt-dlp GitHub repo in the user's
 * default browser via the existing `openExternal` IPC (which
 * gates on http(s) schemes — defense in depth for any future
 * misuse). Mounts inside the YtDlpStatusLine wherever the
 * narrative references "GitHub", so the user has a one-click
 * path to the source of the version we're talking about. */
const YT_DLP_REPO_URL = 'https://github.com/yt-dlp/yt-dlp';

const YtDlpRepoLink = ({ children }: { children: React.ReactNode }): React.JSX.Element => {
  const handleClick = (event: React.MouseEvent): void => {
    event.preventDefault();
    api.openExternal(YT_DLP_REPO_URL).catch((err: unknown) => {
      console.error('openExternal rejected:', err);
    });
  };
  return (
    <a
      href={YT_DLP_REPO_URL}
      onClick={handleClick}
      className="underline decoration-neutral-700 underline-offset-2 transition hover:text-neutral-300 hover:decoration-neutral-500"
    >
      {children}
    </a>
  );
};

const CurrentVersionLabel = ({
  installedVersion,
  source,
}: {
  installedVersion: string | undefined;
  source: 'bundled' | 'auto-updated';
}): React.JSX.Element => (
  <>
    Current: {installedVersion ?? 'unknown'}{' '}
    <span className="text-neutral-600">({source === 'bundled' ? 'bundled' : 'auto-updated'})</span>
  </>
);

const ClearTempFoldersRow = (): React.JSX.Element => {
  const [state, setState] = useState<ClearState>({ phase: 'idle' });

  const handleClick = async (): Promise<void> => {
    setState({ phase: 'clearing' });
    try {
      const result = await api.clearTempFolders();
      setState({
        phase: 'done',
        cleared: result.cleared,
        skippedActive: result.skippedActive,
      });
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Failed.',
      });
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-neutral-200">Clear debug temp folders</div>
        <div className="text-xs text-neutral-500">
          Removes every per-download workspace under the cache directory. Active downloads are
          skipped so their files aren't yanked mid-write.
        </div>
        {state.phase === 'done' ? (
          <div className="mt-0.5 text-xs text-emerald-400">
            Cleared {state.cleared} folder{state.cleared === 1 ? '' : 's'}.
            {state.skippedActive > 0
              ? ` Skipped ${state.skippedActive} active download${state.skippedActive === 1 ? '' : 's'}.`
              : ''}
          </div>
        ) : state.phase === 'error' ? (
          <div className="mt-0.5 text-xs text-red-400">{state.message}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={state.phase === 'clearing'}
        className="shrink-0 rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state.phase === 'clearing' ? 'Clearing…' : 'Clear'}
      </button>
    </div>
  );
};

// ---- cookies ----------------------------------------------------------

type CookiesState = { phase: 'idle' } | { phase: 'saving' } | { phase: 'error'; message: string };

/** Browser-cookies dropdown + per-browser permission hint. Help text
 * differs per browser because macOS surfaces different permission
 * prompts (Full Disk Access for Safari, Keychain for Chromium-family,
 * none for Firefox).
 *
 * The dropdown filters to browsers actually present on the Mac (cookies
 * file exists) so users don't see paradoxical options. If the user has
 * a saved value for a browser that's no longer detected (uninstall),
 * we keep it in the list with a "(not detected)" suffix so they can
 * see and change it. */
const CookiesSection = ({
  overrideExtracted,
}: {
  overrideExtracted?: ExtractedFlags;
}): React.JSX.Element => {
  const [value, setValue] = useState<BrowserName | ''>('');
  const [state, setState] = useState<CookiesState>({ phase: 'idle' });
  const [loaded, setLoaded] = useState(false);
  const [installed, setInstalled] = useState<readonly BrowserName[]>([]);

  useEffect(() => {
    // Parallel: settings tells us the current value, detection tells
    // us which options to surface.
    Promise.all([api.getSettings(), api.detectInstalledBrowsers()])
      .then(([s, browsers]) => {
        setValue(s.cookiesFromBrowser ?? '');
        setInstalled(browsers);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        console.error('cookies section boot rejected:', err);
        // Fall back to all browsers — better than locking the user
        // out of the dropdown if detection fails.
        setInstalled(BROWSER_NAMES);
        setLoaded(true);
      });
  }, []);

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value as BrowserName | '';
    setValue(next);
    setState({ phase: 'saving' });
    // The patch carries the cookiesFromBrowser KEY in both cases —
    // value === undefined signals "clear it" to main. Main detects
    // intent by key presence (structured-clone IPC preserves the key
    // even when its value is undefined), so a missing key means
    // "no change". Sending an explicit clear is the only way to
    // distinguish None-picked from no-change.
    const patch: Partial<Settings> =
      next === '' ? { cookiesFromBrowser: undefined } : { cookiesFromBrowser: next };
    api
      .updateSettings(patch)
      .then(() => setState({ phase: 'idle' }))
      .catch((err: unknown) => {
        console.error('updateSettings rejected:', err);
        setState({ phase: 'error', message: 'Failed to save.' });
      });
  };

  if (!loaded) {
    // Render an inert select skeleton so the section height doesn't
    // jump when getSettings + detection resolve a tick later.
    return (
      <select
        disabled
        className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-500"
      />
    );
  }

  // Render the saved value even if it's not in `installed` (e.g. the
  // user uninstalled Chrome after saving), suffixed so they know to
  // change it. Avoids the dropdown silently dropping their selection.
  const options: Array<{ name: BrowserName; label: string }> = installed.map((name) => ({
    name,
    label: BROWSER_LABEL[name],
  }));
  if (value !== '' && !installed.includes(value)) {
    options.push({ name: value, label: `${BROWSER_LABEL[value]} (not detected)` });
  }
  // Empty-state message when no supported browser is found on disk.
  const noBrowsersDetected = installed.length === 0;

  // Lock whenever an override is active — the saved cookies setting
  // won't take effect because the override path skips it entirely. If
  // the override pins --cookies-from-browser, surface that browser;
  // otherwise show "None" since the override doesn't include cookies.
  const overridden = overrideExtracted !== undefined;
  const overrideCookies = overrideExtracted?.cookiesFromBrowser;
  if (overrideCookies !== undefined && !options.some((o) => o.name === overrideCookies)) {
    options.push({ name: overrideCookies, label: BROWSER_LABEL[overrideCookies] });
  }
  const displayValue: BrowserName | '' = overridden ? (overrideCookies ?? '') : value;

  return (
    <div className="space-y-1.5">
      <select
        value={displayValue}
        onChange={handleChange}
        disabled={overridden}
        className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-60"
      >
        <option value="">None (don't use browser cookies)</option>
        {options.map((opt) => (
          <option key={opt.name} value={opt.name}>
            {opt.label}
          </option>
        ))}
      </select>
      {overridden ? (
        <p className="text-xs text-neutral-500">
          Locked by yt-dlp command override in Developer settings.
        </p>
      ) : null}
      <p className="text-xs text-neutral-500">
        {noBrowsersDetected
          ? 'No supported browser cookies found on this Mac.'
          : value === ''
            ? COOKIES_NONE_HELP
            : BROWSER_HELP[value]}
      </p>
      {state.phase === 'error' ? <p className="text-xs text-red-400">{state.message}</p> : null}
    </div>
  );
};

const BROWSER_LABEL: Record<BrowserName, string> = {
  chrome: 'Chrome',
  firefox: 'Firefox',
  safari: 'Safari',
  brave: 'Brave',
  edge: 'Edge',
};

const COOKIES_NONE_HELP =
  'Default. Pick a browser to use its cookies for login-required videos (age-gated YouTube, private Vimeo, etc.).';

const BROWSER_HELP: Record<BrowserName, string> = {
  safari:
    'macOS will ask you to grant Pluck Full Disk Access the first time. Allow it in System Settings → Privacy & Security → Full Disk Access.',
  chrome: 'macOS will prompt for Keychain access the first time. Click Allow.',
  brave: 'macOS will prompt for Keychain access the first time. Click Allow.',
  edge: 'macOS will prompt for Keychain access the first time. Click Allow.',
  firefox: 'No permission prompt — works out of the box.',
};

// ---- api keys --------------------------------------------------------

type KeyRowState =
  | { phase: 'loading' }
  | { phase: 'empty' }
  | { phase: 'saved' }
  | { phase: 'editing'; value: string }
  | { phase: 'saving' }
  | { phase: 'testing' }
  | { phase: 'tested-ok' }
  | { phase: 'tested-fail'; message: string };

type KeyRowProps = {
  provider: SecretName;
  label: string;
  help: string;
};

/** One API key row: shows "Saved" pill when present, switches to an
 * input + Test + Save when the user clicks Edit, supports Delete. The
 * key string is never sent back to the renderer — we only know whether
 * it's saved, not the value. */
const ApiKeyRow = ({ provider, label, help }: KeyRowProps): React.JSX.Element => {
  const [state, setState] = useState<KeyRowState>({ phase: 'loading' });

  useEffect(() => {
    api
      .hasApiKeys()
      .then((keys) => {
        setState({ phase: keys[provider] ? 'saved' : 'empty' });
      })
      .catch((err: unknown) => {
        console.error('hasApiKeys rejected:', err);
        setState({ phase: 'empty' });
      });
  }, [provider]);

  const startEdit = (): void => setState({ phase: 'editing', value: '' });
  const cancelEdit = (): void => {
    // Back to whatever we were before — re-query for truth.
    setState({ phase: 'loading' });
    api
      .hasApiKeys()
      .then((keys) => setState({ phase: keys[provider] ? 'saved' : 'empty' }))
      .catch(() => setState({ phase: 'empty' }));
  };

  const handleTest = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    setState({ phase: 'testing' });
    try {
      const result = await api.testApiKey(provider, trimmed);
      setState(
        result.ok ? { phase: 'tested-ok' } : { phase: 'tested-fail', message: result.error },
      );
    } catch (err) {
      setState({
        phase: 'tested-fail',
        message: err instanceof Error ? err.message : 'Test failed.',
      });
    }
  };

  const handleSave = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    setState({ phase: 'saving' });
    try {
      const result = await api.saveApiKey(provider, trimmed);
      setState(result.ok ? { phase: 'saved' } : { phase: 'tested-fail', message: result.error });
    } catch (err) {
      setState({
        phase: 'tested-fail',
        message: err instanceof Error ? err.message : 'Save failed.',
      });
    }
  };

  const handleDelete = async (): Promise<void> => {
    try {
      await api.deleteApiKey(provider);
      setState({ phase: 'empty' });
    } catch (err) {
      console.error('deleteApiKey rejected:', err);
    }
  };

  if (state.phase === 'loading') {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-500">
        {label}: loading…
      </div>
    );
  }

  if (state.phase === 'saved') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-neutral-200">{label}</div>
          <div className="text-xs text-emerald-400">Saved.</div>
        </div>
        <button
          type="button"
          onClick={startEdit}
          className="rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          className="rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-300 transition hover:border-red-900/70 hover:bg-red-950/40 hover:text-red-300"
        >
          Delete
        </button>
      </div>
    );
  }

  if (state.phase === 'empty') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-neutral-200">{label}</div>
          <div className="text-xs text-neutral-500">{help}</div>
        </div>
        <button
          type="button"
          onClick={startEdit}
          className="rounded border border-neutral-800 px-2 py-0.5 text-xs text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100"
        >
          Add
        </button>
      </div>
    );
  }

  // editing / saving / testing / tested-* — all share the input + buttons layout
  const editingValue = state.phase === 'editing' ? state.value : '';
  const busy = state.phase === 'saving' || state.phase === 'testing';

  return (
    <div className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="text-xs font-medium text-neutral-200">{label}</div>
      <div className="flex gap-2">
        <input
          type="password"
          value={editingValue}
          onChange={(event) => setState({ phase: 'editing', value: event.target.value })}
          placeholder="sk-…"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void handleTest(editingValue)}
          disabled={busy || editingValue.trim().length === 0}
          className="shrink-0 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.phase === 'testing' ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          onClick={() => void handleSave(editingValue)}
          disabled={busy || editingValue.trim().length === 0}
          className="shrink-0 rounded-md border border-neutral-600 bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.phase === 'saving' ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 text-xs">
        {state.phase === 'tested-ok' ? (
          <span className="text-emerald-400">Key works.</span>
        ) : state.phase === 'tested-fail' ? (
          <span className="text-red-400">{state.message}</span>
        ) : (
          <span className="text-neutral-500">{help}</span>
        )}
        <button
          type="button"
          onClick={cancelEdit}
          className="shrink-0 text-neutral-500 transition hover:text-neutral-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

// ---- version footer --------------------------------------------------

const VersionFooter = (): React.JSX.Element => {
  const [version, setVersion] = useState<string | undefined>(undefined);

  useEffect(() => {
    api
      .getAppVersion()
      .then(setVersion)
      .catch((err: unknown) => {
        console.error('getAppVersion rejected:', err);
      });
  }, []);

  return (
    <footer className="border-t border-neutral-800 px-4 py-2 text-xs text-neutral-500">
      Pluck {version ?? '—'}
    </footer>
  );
};
