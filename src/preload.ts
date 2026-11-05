import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('anino', {
  onAssistantDraft: (callback: (text: string) => void) => ipcRenderer.on('assistant-draft', (_event, text) => callback(text)),
  askPet: (turns: unknown, scope: string) => ipcRenderer.invoke('ask-pet', turns, scope),
  aiSettings: () => ipcRenderer.invoke('ai-settings'),
  saveAiSettings: (input: unknown, remove: boolean) => ipcRenderer.invoke('save-ai-settings', input, remove),
  testAiSettings: (input: unknown) => ipcRenderer.invoke('test-ai-settings', input),
  approveProjectEdit: (id: string, apply: boolean) => ipcRenderer.invoke('approve-project-edit', id, apply),
  assistantFile: (index: number, action: string) => ipcRenderer.invoke('assistant-file', index, action),
  setupNotifications: () => ipcRenderer.invoke('setup-notifications'),
  onAlert: (callback: (alert: { source: string; message: string; count: number }) => void) =>
    ipcRenderer.on('pet-alert', (_event, alert) => callback(alert)),
  onOpenControls: (callback: () => void) => ipcRenderer.on('open-controls', callback),
  onCareFeedback: (callback: (reaction: { mood: string; message: string }) => void) => ipcRenderer.on('care-feedback', (_event, reaction) => callback(reaction)),
  preferences: (input: unknown) => ipcRenderer.invoke('preferences', input),
  resizePanel: (input: unknown) => ipcRenderer.invoke('resize-panel', input),
  ready: () => ipcRenderer.send('renderer-ready'),
  todo: (input: unknown) => ipcRenderer.invoke('todo', input),
  routines: (input: unknown) => ipcRenderer.invoke('routines', input),
  customizePet: (input: unknown) => ipcRenderer.invoke('customize-pet', input),
  returnToScreen: () => ipcRenderer.invoke('return-to-screen'),
  weatherSearch: (query: string) => ipcRenderer.invoke('weather-search', query),
  weatherLocation: (location: unknown) => ipcRenderer.invoke('weather-location', location),
  weatherDetect: () => ipcRenderer.invoke('weather-detect'),
  weatherRefresh: () => ipcRenderer.invoke('weather-refresh'),
  weatherProvider: () => ipcRenderer.invoke('weather-provider'),
  roam: (start: boolean) => ipcRenderer.invoke('roam', start),
  toyStage: (open: boolean) => ipcRenderer.invoke('toy-stage', open),
  hit: (interactive: boolean) => ipcRenderer.send('hit', interactive),
  drag: (phase: 'start' | 'move' | 'end') => ipcRenderer.send('drag', phase),
  select: (kind: string, name: string) => ipcRenderer.invoke('select-pet', kind, name),
  status: () => ipcRenderer.invoke('status'),
  act: (action: string) => ipcRenderer.invoke('act', action),
});










