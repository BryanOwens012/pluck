import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipc-channels';
import type { Download, DownloadRequest } from '../shared/types';

if (!process.contextIsolated) {
  throw new Error('Context isolation must be enabled in the BrowserWindow webPreferences.');
}

/** The typed surface the renderer sees as `window.pluck`. Keep narrow — every
 * new field is a new IPC handler in main/ipc.ts plus a new channel constant. */
const api = {
  startDownload: (request: DownloadRequest): Promise<{ id: string }> =>
    ipcRenderer.invoke(IpcChannels.StartDownload, request),

  /** Subscribe to push updates for any download. Returns an unsubscribe
   * function that removes only this listener — important to call from
   * useEffect cleanup so renderer reloads don't leak listeners. */
  onDownloadUpdate: (callback: (download: Download) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, download: Download): void => {
      callback(download);
    };
    ipcRenderer.on(IpcChannels.DownloadUpdate, listener);
    return (): void => {
      ipcRenderer.removeListener(IpcChannels.DownloadUpdate, listener);
    };
  },
};

export type PluckAPI = typeof api;

try {
  contextBridge.exposeInMainWorld('pluck', api);
} catch (error) {
  console.error(error);
}
