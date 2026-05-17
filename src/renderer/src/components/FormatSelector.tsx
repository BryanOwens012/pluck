import type { Format } from '../../../shared/types';

type Props = {
  value: Format;
  onChange: (format: Format) => void;
};

type Option = { value: Format; label: string };

const OPTIONS: readonly Option[] = [
  { value: 'best', label: 'Best Quality' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: 'audio_mp3', label: 'Audio Only (MP3)' },
] as const;

export const FormatSelector = ({ value, onChange }: Props): React.JSX.Element => {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as Format)}
      className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
    >
      {OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
};
