import { api } from '../lib/api';

type Props = {
  /** Current persisted output folder. Comes from App's settings state so
   * the displayed value updates immediately after the user picks a new
   * folder. */
  outputFolder: string;
  /** Called with the new folder when the user accepts the picker. App
   * uses this to update its local settings state. */
  onChange: (next: string) => void;
};

/** Compact row: "Save to <path>  [Change…]". The path is the truthy
 * source — clicking Change opens the native dialog; cancel is a no-op. */
export const OutputFolderPicker = ({ outputFolder, onChange }: Props): React.JSX.Element => {
  const handleChange = (): void => {
    api
      .chooseOutputFolder()
      .then((picked) => {
        if (picked) {
          onChange(picked);
        }
      })
      .catch((err: unknown) => {
        console.error('chooseOutputFolder rejected:', err);
      });
  };

  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <span className="shrink-0">Save to</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-neutral-400"
        title={outputFolder}
        // dir=rtl keeps the meaningful tail of the path visible when it's
        // too long to fit — better than truncating the home directory.
        dir="rtl"
      >
        {outputFolder}
      </span>
      <button
        type="button"
        onClick={handleChange}
        className="shrink-0 rounded border border-neutral-800 px-2 py-0.5 text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100 focus:outline-none focus-visible:bg-neutral-900"
      >
        Change…
      </button>
    </div>
  );
};
