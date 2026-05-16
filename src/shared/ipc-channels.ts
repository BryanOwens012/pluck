/**
 * Single source of truth for IPC channel names. Both the main process
 * (ipcMain.handle / webContents.send) and the preload bridge (ipcRenderer.invoke
 * / on) import from here, so a typo breaks at compile time instead of silently
 * dropping messages.
 */

export const IpcChannels = {
  /** Renderer -> main, invoke. Starts a single download. Returns the new id. */
  StartDownload: 'pluck:start-download',
  /** Main -> renderer, send. Pushes the latest Download state for any id. */
  DownloadUpdate: 'pluck:download-update',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
