import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('remoteDesktop', {
  getState: () => ipcRenderer.invoke('remote:state'),
  start: () => ipcRenderer.invoke('remote:start'),
  stop: () => ipcRenderer.invoke('remote:stop'),
  setPassword: (password: string, confirmation: string) => ipcRenderer.invoke('remote:password', password, confirmation),
  setNetwork: (host: string, port: number) => ipcRenderer.invoke('remote:network', host, port),
  copyUrl: () => ipcRenderer.invoke('remote:copy-url'),
});
