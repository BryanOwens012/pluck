import { useEffect, useState } from 'react';
import type { Download, Format } from '../../shared/types';
import { DownloadQueue } from './components/DownloadQueue';
import { FormatSelector } from './components/FormatSelector';
import { OutputFolderPicker } from './components/OutputFolderPicker';
import { UrlInput } from './components/UrlInput';
import { api } from './lib/api';

const App = (): React.JSX.Element => {
  // Keyed by Download.id so push updates replace by id; rendered as a list
  // sorted by createdAt descending (newest first). One state owner, one
  // consumer (DownloadQueue) — no need for a global store yet.
  const [downloads, setDownloads] = useState<Map<string, Download>>(() => new Map());
  const [format, setFormat] = useState<Format>('best');
  // Settings snapshot. Loaded once on mount, updated optimistically when
  // the picker accepts a new folder (main has already persisted by the
  // time it resolves with the path).
  const [outputFolder, setOutputFolder] = useState<string | undefined>(undefined);

  // Boot: subscribe to push updates first so any update emitted while
  // getInitialState is in-flight still lands. Seed merges with existing-
  // wins semantics — a newer pushed row isn't clobbered by the older
  // snapshot from main.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.onDownloadUpdate((download) => {
      setDownloads((prev) => {
        const next = new Map(prev);
        next.set(download.id, download);
        return next;
      });
    });
    api
      .getInitialState()
      .then((initial) => {
        if (cancelled) {
          return;
        }
        setDownloads((prev) => {
          const next = new Map(prev);
          for (const d of initial) {
            if (!next.has(d.id)) {
              next.set(d.id, d);
            }
          }
          return next;
        });
      })
      .catch((err: unknown) => {
        console.error('getInitialState rejected:', err);
      });
    api
      .getSettings()
      .then((settings) => {
        if (!cancelled) {
          setOutputFolder(settings.outputFolder);
        }
      })
      .catch((err: unknown) => {
        console.error('getSettings rejected:', err);
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleSubmit = (url: string): void => {
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
        {outputFolder !== undefined ? (
          <OutputFolderPicker outputFolder={outputFolder} onChange={setOutputFolder} />
        ) : null}
        <DownloadQueue rows={rows} />
      </div>
    </main>
  );
};

export default App;
