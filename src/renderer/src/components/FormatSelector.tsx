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
   * the single-entry "Best (TBD)" placeholder while a probe runs, or
   * the per-URL probe result (1-3 dedup'd tiers + audio_mp3 + an
   * optional 5th `best_alt` for non-mp4 alternatives). */
  choices: readonly FormatChoice[];
  /** When true, append the per-URL `detail` ("1920×1080 mp4, 60fps")
   * to every choice. When false, only `best_alt` shows its detail —
   * the four standard presets stay terse so the dropdown labels don't
   * shift length when the probe lands. `best_alt` is the exception
   * because its whole purpose is to surface a different container /
   * higher resolution, which the detail spells out. */
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
      className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
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
 *  - `best_alt`: always full `detail` (its whole purpose is to tell the
 *    user "different container, higher specs"), regardless of debug.
 *  - Debug on: full `detail` for any choice that has one.
 *  - Debug off: `shorthand` only (terse — "1080p", "4K"). The four
 *    standard presets that lack a shorthand render bare. */
const pickSuffix = (choice: FormatChoice, debugMode: boolean): string | undefined => {
  if (choice.id === 'best_alt') {
    return choice.detail;
  }
  if (debugMode) {
    return choice.detail;
  }
  return choice.shorthand;
};
