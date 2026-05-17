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

  // Boot: pull the full snapshot from main (persisted history + any live
  // in-flight rows) and seed the store. Subscribe to push updates first so
  // any update emitted while getInitialState is in-flight still lands.
  // upsert overwrites by id, so a later seed() including the same row is
  // harmless; if the live update is newer, the next push will correct it.
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
