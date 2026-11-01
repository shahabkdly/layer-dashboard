'use strict';
/* The only bridge between the page and Node. The page gets a short, explicit list of
   desktop actions; it has no file system access of its own (contextIsolation + sandbox). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('app:version'),
  /** Native "open" dialog -> [{ name, data: Uint8Array }] */
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  /** Native folder dialog for a .gdb; the folder is zipped in memory -> { name, data } */
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  /** Files given on the command line or dropped on the app icon */
  readPaths: paths => ipcRenderer.invoke('files:read', paths),
  /** Native "save" dialog; data is a string or Uint8Array -> saved path or null */
  save: (suggestedName, data, filters) => ipcRenderer.invoke('dialog:save', suggestedName, data, filters),
  /** Menu commands from the main process: cb(action) */
  onMenu: cb => ipcRenderer.on('menu', (_e, action) => cb(action)),
  /** Files to open at start-up, or opened while running */
  onOpenPaths: cb => ipcRenderer.on('open-paths', (_e, paths) => cb(paths)),
  /** Keeps the window title in step with the dashboard title */
  setTitle: t => ipcRenderer.send('app:title', t),
  /** Light or dark: remembered so the window opens in the same colours next time */
  setTheme: t => ipcRenderer.send('app:theme', t)
});
