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
  /** Renderer -> main, invoke. Opens Finder showing the parent folder of the
   * given file with the file selected. macOS "Reveal in Finder" semantics. */
  ShowInFinder: 'pluck:show-in-finder',
  /** Renderer -> main, invoke. Opens an https URL in the user's default
   * browser via shell.openExternal. Used by the source-site icon. */
  OpenExternal: 'pluck:open-external',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
