import { useEffect, useState } from 'react';
import type { Download, Format } from '../../shared/types';
import { DownloadRow } from './components/DownloadRow';
import { FormatSelector } from './components/FormatSelector';
import { UrlInput } from './components/UrlInput';
import { api } from './lib/api';

const App = (): React.JSX.Element => {
  // Map keyed by Download.id so push updates from the main process replace
  // by id; rendered as a list sorted by createdAt descending (newest first).
  const [downloads, setDownloads] = useState<Map<string, Download>>(() => new Map());
  const [format, setFormat] = useState<Format>('best');

  useEffect(() => {
    // api.onDownloadUpdate is a module-stable function exposed via
    // contextBridge; subscribe once on mount and unsubscribe on unmount.
    return api.onDownloadUpdate((download) => {
      setDownloads((prev) => {
        const next = new Map(prev);
        next.set(download.id, download);
        return next;
      });
    });
  }, []);

  const handleSubmit = (url: string): void => {
    // Main returns the id synchronously and streams the rest via
    // DownloadUpdate. The only way invoke rejects is if the handler itself
    // throws (e.g. mkdirSync fails); surface that to the console rather
    // than silently swallowing it.
    api.startDownload({ url, format }).catch((err: unknown) => {
      console.error('startDownload rejected:', err);
    });
  };

  const rows = Array.from(downloads.values()).sort((a, b) => b.createdAt - a.createdAt);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-2xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Pluck</h1>
        <div className="flex gap-2">
          <UrlInput onSubmit={handleSubmit} />
          <FormatSelector value={format} onChange={setFormat} />
        </div>
        <div className="space-y-2">
          {rows.length === 0 ? (
            <p className="text-sm text-neutral-500">Paste a video URL above to start a download.</p>
          ) : (
            rows.map((download) => <DownloadRow key={download.id} download={download} />)
          )}
        </div>
      </div>
    </main>
  );
};

export default App;
