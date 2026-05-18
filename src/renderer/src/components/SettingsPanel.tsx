import { useEffect, useState } from 'react';
import type { SecretName } from '../../../main/secrets';
import type { Settings } from '../../../main/settings';
import { BROWSER_NAMES, type BrowserName } from '../../../shared/types';
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
  /** Called to close the panel. */
  onClose: () => void;
};

/** Backdrop + modal wrapper. Centered, max-width-md, dismissable via
 * backdrop click or Esc. Pattern matches PasswordPrompt — kept inline
 * rather than extracting a Modal component until we have a 3rd modal. */
export const SettingsPanel = ({
  outputFolder,
  onOutputFolderChange,
  debugMode,
  onDebugModeChange,
  onClose,
}: Props): React.JSX.Element => {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onClose();
        }
      }}
    >
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col rounded-lg border border-neutral-800 bg-neutral-900 shadow-xl">
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 id="settings-title" className="text-sm font-semibold text-neutral-100">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded p-1 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
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
            <CookiesSection />
          </section>
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              API keys
            </h3>
            <p className="text-xs text-neutral-500">
              Optional. Pluck will prompt you the first time a feature needs a key.
            </p>
            <ApiKeyRow
              provider="elevenlabs"
              label="ElevenLabs"
              help="Powers transcription (Transcribe button on completed downloads)."
            />
            <ApiKeyRow
              provider="anthropic"
              label="Anthropic"
              help="Powers AI prompt suggestions (coming soon)."
            />
          </section>
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
              Developer
            </h3>
            <DebugModeRow debugMode={debugMode} onChange={onDebugModeChange} />
            <ConcurrentDownloadsRow />
            <ConcurrentFragmentsRow />
            <ClearTempFoldersRow />
          </section>
        </div>
        <VersionFooter />
      </div>
    </div>
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

  return (
    <div className="space-y-1.5 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-neutral-200">{label}</div>
          <div className="text-xs text-neutral-500">{description}</div>
        </div>
        <select
          value={loaded ? value : initialDefault}
          onChange={handleChange}
          disabled={!loaded}
          className="shrink-0 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-50"
        >
          {options.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
    </div>
  );
};

const ConcurrentFragmentsRow = (): React.JSX.Element => (
  <ConcurrencyRow
    settingKey="concurrentFragments"
    label="Concurrent fragments"
    description={`yt-dlp's -N flag (parallel chunks per single download). Higher = faster, but can trip per-server rate limits. Default ${DEFAULT_CONCURRENT_FRAGMENTS}.`}
    min={MIN_CONCURRENT_FRAGMENTS}
    max={MAX_CONCURRENT_FRAGMENTS}
    initialDefault={DEFAULT_CONCURRENT_FRAGMENTS}
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
  | { phase: 'done'; cleared: number }
  | { phase: 'error'; message: string };

const ClearTempFoldersRow = (): React.JSX.Element => {
  const [state, setState] = useState<ClearState>({ phase: 'idle' });

  const handleClick = async (): Promise<void> => {
    setState({ phase: 'clearing' });
    try {
      const result = await api.clearTempFolders();
      setState({ phase: 'done', cleared: result.cleared });
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
          Removes every per-download workspace under the cache directory.
        </div>
        {state.phase === 'done' ? (
          <div className="mt-0.5 text-xs text-emerald-400">Cleared {state.cleared} folders.</div>
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

const CloseIcon = (): React.JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="h-4 w-4"
  >
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

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
const CookiesSection = (): React.JSX.Element => {
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

  return (
    <div className="space-y-1.5">
      <select
        value={value}
        onChange={handleChange}
        className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
      >
        <option value="">None (don't use browser cookies)</option>
        {options.map((opt) => (
          <option key={opt.name} value={opt.name}>
            {opt.label}
          </option>
        ))}
      </select>
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
