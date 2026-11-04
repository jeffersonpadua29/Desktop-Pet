import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('anino', {
  setupNotifications: () => ipcRenderer.invoke('setup-notifications'),
  onAlert: (callback: (alert: { source: string; message: string; count: number }) => void) =>
    ipcRenderer.on('pet-alert', (_event, alert) => callback(alert)),
  roam: (start: boolean) => ipcRenderer.invoke('roam', start),
  toyStage: (open: boolean) => ipcRenderer.invoke('toy-stage', open),
  hit: (interactive: boolean) => ipcRenderer.send('hit', interactive),
  drag: (x: number, y: number) => ipcRenderer.send('drag', x, y),
  command: (input: string) => ipcRenderer.invoke('command', input),
  select: (kind: string, name: string) => ipcRenderer.invoke('select-pet', kind, name),
  status: () => ipcRenderer.invoke('status'),
  act: (action: string) => ipcRenderer.invoke('act', action),
});








