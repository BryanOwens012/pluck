import { useEffect, useState } from 'react';
import type { Format } from '../../shared/types';
import { DownloadQueue } from './components/DownloadQueue';
import { FormatSelector } from './components/FormatSelector';
import { UrlInput } from './components/UrlInput';
import { api } from './lib/api';
import { useDownloadsStore } from './stores/downloads';

const App = (): React.JSX.Element => {
  const seed = useDownloadsStore((s) => s.seed);
  const upsert = useDownloadsStore((s) => s.upsert);
  const [format, setFormat] = useState<Format>('best');

  // Boot: subscribe to push updates first so any update emitted while
  // getInitialState is in-flight still lands. Then seed with the snapshot
  // from main — seed merges (existing wins on id), so a newer pushed row
  // isn't clobbered by the older snapshot.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.onDownloadUpdate(upsert);
    api
      .getInitialState()
      .then((downloads) => {
        if (!cancelled) {
          seed(downloads);
        }
      })
      .catch((err: unknown) => {
        console.error('getInitialState rejected:', err);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [seed, upsert]);

  const handleSubmit = (url: string): void => {
    api.startDownload({ url, format }).catch((err: unknown) => {
      console.error('startDownload rejected:', err);
    });
  };

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pluck</h1>
        <div className="flex gap-2">
          <UrlInput onSubmit={handleSubmit} />
          <FormatSelector value={format} onChange={setFormat} />
        </div>
        <DownloadQueue />
      </div>
    </main>
  );
};

export default App;
