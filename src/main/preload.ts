// Ponte entre a barra lateral e o processo principal. Só a janela da interface
// usa este preload; as abas dos jogos não recebem nada injetado.

import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  listGames: invoke('games:list'),
  listProfiles: invoke('profiles:list'),
  addProfile: invoke('profiles:add'),
  removeProfile: invoke('profiles:remove'),
  openProfile: invoke('profiles:open'),
  closeProfile: invoke('profiles:close'),
  setLayout: invoke('layout:set'),
  getSettings: invoke('settings:get'),
  setTurbo: invoke('turbo:set'),
  setSidebarCollapsed: invoke('sidebar:set'),
  selectView: invoke('view:select'),
  reloadView: invoke('view:reload'),
  muteView: invoke('view:mute'),
  getMetrics: invoke('metrics:get'),
  go: invoke('nav:go'),
  setRecording: invoke('record:set'),
  getState: invoke('state:get'),
  listAlerts: invoke('alerts:list'),
  getRecommendations: invoke('recommendations:get'),
  compareHunts: invoke('hunts:compare'),
  getPrices: invoke('prices:get'),
  setPrices: invoke('prices:set'),
  setAutomation: invoke('automation:set'),
  runAction: invoke('action:run'),
  ask: invoke('assistant:ask'),
  on: (channel: 'state' | 'recommendations' | 'log' | 'alert' | 'tiles', listener: (payload: unknown) => void) => {
    ipcRenderer.on(channel, (_e, payload) => listener(payload));
  },
});
