import type { FormatChoice } from '../../../shared/types';

type Props = {
  /** Currently-selected choice. */
  value: FormatChoice;
  /** Called with the user's new pick — `<select>` returns the choice's
   * `id`, this component resolves back to the full FormatChoice via
   * `choices` and bubbles the object up so the parent stores the
   * complete args + label set. */
  onChange: (choice: FormatChoice) => void;
  /** Choices to render. Comes from App, which uses one of: the static
   * defaults (boot / invalid URL — dropdown is hidden in that case),
   * the pre-probe placeholder list while a probe runs ("Best", "1080p
   * mp4", …, "Audio-only mp3"), or the per-URL probe result (Best
   * annotated with actual resolution + merged container, plus the
   * subset of lower tiers that are available and don't duplicate
   * Best). */
  choices: readonly FormatChoice[];
  /** Reserved for future verbose detail annotation. Currently the same
   * label is shown regardless — the post-probe Best already carries
   * its resolution + container in `detail`, which is sufficient. */
  debugMode: boolean;
  /** True while the per-URL format probe is in flight. The select
   * gets `aria-busy` for assistive tech and a small inline spinner
   * overlays the right edge (inside the select's reserved padding) so
   * sighted users see the choices are still being refined. */
  isProbing?: boolean;
};

/** Quality / format dropdown. Pure presentational — App owns the
 * choice list (static defaults vs per-URL enriched) and the currently-
 * selected value. */
export const FormatSelector = ({
  value,
  onChange,
  choices,
  debugMode,
  isProbing,
}: Props): React.JSX.Element => {
  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const nextId = event.target.value;
    const next = choices.find((c) => c.id === nextId);
    if (next !== undefined) {
      onChange(next);
    }
  };
  return (
    <span className="relative inline-flex items-center">
      <select
        value={value.id}
        onChange={handleChange}
        aria-busy={isProbing === true}
        // pr-9 reserves space for the spinner so it sits next to the
        // native chevron rather than overlapping the option text.
        className={`rounded-md border border-neutral-200 bg-white py-2 pl-3 text-sm text-neutral-900 focus:border-neutral-600 focus:outline-none focus:ring-2 focus:ring-neutral-500 ${
          isProbing ? 'pr-9' : 'pr-3'
        }`}
      >
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {formatLabel(choice, debugMode)}
          </option>
        ))}
      </select>
      {isProbing ? (
        <span
          aria-hidden="true"
          title="Detecting available formats…"
          className="pointer-events-none absolute right-2 text-neutral-500"
        >
          <ProbeSpinner />
        </span>
      ) : null}
    </span>
  );
};

/** Animated spinner shown inside the format dropdown while the yt-dlp
 * metadata probe is in flight. Pure CSS animation — no JS timer, no
 * re-render per frame. Hidden from assistive tech (the parent select's
 * aria-busy carries the message instead of a polite-live-region
 * announcement that re-fires on every URL edit). */
const ProbeSpinner = (): React.JSX.Element => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    aria-hidden="true"
    className="h-3 w-3 animate-spin"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const formatLabel = (choice: FormatChoice, debugMode: boolean): string => {
  const suffix = pickSuffix(choice, debugMode);
  return suffix ? `${choice.label} (${suffix})` : choice.label;
};

/** Which parenthesised suffix to render next to a choice's label.
 *
 * - `detail` is the canonical post-probe annotation for "Best" —
 *   "1080p mp4" / "4K mkv". Other presets carry their resolution +
 *   container directly in the label ("1080p mp4", "Audio-only mp3")
 *   so they have no detail and render bare.
 * - Debug mode preserves the wider verbose detail (e.g. "1920×1080
 *   mp4, 60fps") if any preset surfaces one in the future, but the
 *   default path is the same.
 *
 * Pre-probe choices have no detail and so render with just their
 * static label ("Best", "1080p mp4", …). */
const pickSuffix = (choice: FormatChoice, debugMode: boolean): string | undefined => {
  if (choice.detail !== undefined) {
    return choice.detail;
  }
  if (debugMode) {
    return choice.detail;
  }
  return undefined;
};
