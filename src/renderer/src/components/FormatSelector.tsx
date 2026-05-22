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
};

/** Quality / format dropdown. Pure presentational — App owns the
 * choice list (static defaults vs per-URL enriched) and the currently-
 * selected value. */
export const FormatSelector = ({
  value,
  onChange,
  choices,
  debugMode,
}: Props): React.JSX.Element => {
  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const nextId = event.target.value;
    const next = choices.find((c) => c.id === nextId);
    if (next !== undefined) {
      onChange(next);
    }
  };
  return (
    <select
      value={value.id}
      onChange={handleChange}
      className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-600 focus:outline-none focus:ring-2 focus:ring-neutral-500"
    >
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {formatLabel(choice, debugMode)}
        </option>
      ))}
    </select>
  );
};

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
