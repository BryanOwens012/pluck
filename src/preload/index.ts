import { electronAPI } from '@electron-toolkit/preload';
import { contextBridge } from 'electron';

if (!process.contextIsolated) {
  throw new Error('Context isolation must be enabled in the BrowserWindow webPreferences.');
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI);
} catch (error) {
  console.error(error);
}
