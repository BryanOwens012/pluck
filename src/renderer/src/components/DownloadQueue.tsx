import type { Download } from '../../../shared/types';
import { DownloadRow } from './DownloadRow';

type Props = {
  /** Newest-first list of downloads (history + live). Empty renders the
   * paste-a-URL hint instead of an empty container. */
  rows: Download[];
  /** Forwarded to each row; opens the password prompt for that id. App
   * owns the prompt state. */
  onOpenPasswordPrompt?: (id: string) => void;
};

/** Renders the queue + history list. Pure presentational — App owns the
 * state and sort order, this just maps to DownloadRow components. */
export const DownloadQueue = ({ rows, onOpenPasswordPrompt }: Props): React.JSX.Element => {
  if (rows.length === 0) {
    return <p className="text-sm text-neutral-500">Paste a video URL above to start a download.</p>;
  }

  return (
    <div className="space-y-2">
      {rows.map((download) => (
        <DownloadRow
          key={download.id}
          download={download}
          onOpenPasswordPrompt={onOpenPasswordPrompt}
        />
      ))}
    </div>
  );
};
