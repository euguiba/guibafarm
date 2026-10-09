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
  listGroups: invoke('groups:list'),
  setGroup: invoke('group:set'),
  setGroupIcon: invoke('group:icon'),
  renameGroup: invoke('group:rename'),
  updateProfile: invoke('profiles:update'),
  reorderProfiles: invoke('profiles:reorder'),
  setZoom: invoke('zoom:set'),
  setSettings: invoke('settings:set'),
  setOverlay: invoke('overlay:set'),
  relaunch: invoke('app:relaunch'),
  updateStatus: invoke('update:status'),
  checkUpdate: invoke('update:check'),
  installUpdate: invoke('update:install'),
  selectView: invoke('view:select'),
  reloadView: invoke('view:reload'),
  muteView: invoke('view:mute'),
  getMetrics: invoke('metrics:get'),
  go: invoke('nav:go'),
  setRecording: invoke('record:set'),
  getState: invoke('state:get'),
  getHunt: invoke('hunt:get'),
  getParty: invoke('party:get'),
  sendTelegram: invoke('telegram:send'),
  setRatios: invoke('ratios:set'),
  setZen: invoke('zen:set'),
  zenReveal: invoke('zen:reveal'),
  pauseHunt: invoke('hunt:pause'),
  resetHunt: invoke('hunt:reset'),
  listAlerts: invoke('alerts:list'),
  getRecommendations: invoke('recommendations:get'),
  compareHunts: invoke('hunts:compare'),
  getPrices: invoke('prices:get'),
  setPrices: invoke('prices:set'),
  setAutomation: invoke('automation:set'),
  runAction: invoke('action:run'),
  ask: invoke('assistant:ask'),
  on: (channel: 'state' | 'recommendations' | 'log' | 'alert' | 'tiles' | 'update' | 'shortcut', listener: (payload: unknown) => void) => {
    ipcRenderer.on(channel, (_e, payload) => listener(payload));
  },
});
