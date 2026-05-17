import { selectRows, useDownloadsStore } from '../stores/downloads';
import { DownloadRow } from './DownloadRow';

/** Renders the queue + history list, newest first. Pulls straight from the
 * Zustand store — App.tsx owns the boot-time seed + subscription wiring;
 * this component just reads. */
export const DownloadQueue = (): React.JSX.Element => {
  const rows = useDownloadsStore(selectRows);

  if (rows.length === 0) {
    return <p className="text-sm text-neutral-500">Paste a video URL above to start a download.</p>;
  }

  return (
    <div className="space-y-2">
      {rows.map((download) => (
        <DownloadRow key={download.id} download={download} />
      ))}
    </div>
  );
};
