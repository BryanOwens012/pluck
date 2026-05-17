import { create } from 'zustand';
import type { Download } from '../../../shared/types';

type DownloadsState = {
  /** Keyed by Download.id so update events replace by id without a list scan.
   * Rendered as a sorted array via the selectors below. */
  downloads: Map<string, Download>;
  /** Replace the entire store. Used once on mount with the initial snapshot
   * from main (history + any live rows). */
  seed: (downloads: Download[]) => void;
  /** Insert or replace one row. Main pushes a full Download per update; we
   * never merge partials renderer-side. */
  upsert: (download: Download) => void;
};

export const useDownloadsStore = create<DownloadsState>((set) => ({
  downloads: new Map(),
  seed: (downloads) =>
    set(() => ({
      downloads: new Map(downloads.map((d) => [d.id, d])),
    })),
  upsert: (download) =>
    set((state) => {
      // New Map per update so React + Zustand's shallow equality treat it as
      // a fresh value. Cheap — Map cloning is O(n) where n is small.
      const next = new Map(state.downloads);
      next.set(download.id, download);
      return { downloads: next };
    }),
}));

/** Sorted newest-first by createdAt. A selector (not a store field) so it
 * recomputes only on the relevant slice and never goes stale. */
export const selectRows = (state: DownloadsState): Download[] =>
  Array.from(state.downloads.values()).sort((a, b) => b.createdAt - a.createdAt);
