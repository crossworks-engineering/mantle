import { contextBridge, ipcRenderer } from 'electron';

/** IPC surface for the connect screen — the shell's only renderer-facing API. */
contextBridge.exposeInMainWorld('mantleDesktop', {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  addProfile: (url: string) => ipcRenderer.invoke('profiles:add', url),
  removeProfile: (id: string) => ipcRenderer.invoke('profiles:remove', id),
  connect: (id: string) => ipcRenderer.invoke('profiles:connect', id),
});
