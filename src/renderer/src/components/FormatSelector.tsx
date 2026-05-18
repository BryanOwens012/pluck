import type { FormatChoice } from '../../../shared/types';

type Props = {
  /** Currently-selected choice. */
  value: FormatChoice;
  /** Called with the user's new pick — `<select>` returns the choice's
   * `id`, this component resolves back to the full FormatChoice via
   * `choices` and bubbles the object up so the parent stores the
   * complete args + label set. */
  onChange: (choice: FormatChoice) => void;
  /** Choices to render. Comes from App, which either uses the static
   * defaults (boot, invalid URL) or the per-URL probe result from
   * format-selector.ts (4 enriched + an optional 5th non-mp4 alt). */
  choices: readonly FormatChoice[];
};

/** Quality / format dropdown. Pure presentational — App owns the
 * choice list (static defaults vs per-URL enriched) and the currently-
 * selected value. */
export const FormatSelector = ({ value, onChange, choices }: Props): React.JSX.Element => {
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
          {choice.label}
        </option>
      ))}
    </select>
  );
};
