// Atualização automática do app instalado: procura uma versão nova no GitHub, baixa em segundo
// plano e instala ao reabrir. O instalador baixado é conferido pelo hash publicado junto (latest.yml).

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

export type UpdateState = 'off' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  current: string;
  state: UpdateState;
  /** Versão nova encontrada ou baixada. */
  version?: string;
  percent?: number;
}

const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

export function startUpdater(onChange: (status: UpdateStatus) => void) {
  const status: UpdateStatus = { current: app.getVersion(), state: app.isPackaged ? 'idle' : 'off' };
  const set = (patch: Partial<UpdateStatus>) => {
    Object.assign(status, patch);
    onChange({ ...status });
  };
  const check = () => {
    if (!app.isPackaged || status.state === 'downloading' || status.state === 'ready') return;
    set({ state: 'checking' });
    autoUpdater.checkForUpdates().catch(() => set({ state: 'error' }));
  };

  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('update-not-available', () => set({ state: 'idle' }));
    autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
    // Sem internet ou sem versão publicada ainda: tenta de novo na próxima rodada, sem incomodar.
    autoUpdater.on('error', () => set({ state: status.state === 'downloading' ? 'error' : 'idle' }));
    setTimeout(check, 15_000);
    setInterval(check, CHECK_EVERY_MS);
  }

  return {
    status: (): UpdateStatus => ({ ...status }),
    check,
    /** Fecha (salvando os logins), instala a versão baixada e abre de novo. */
    install: () => {
      if (status.state === 'ready') autoUpdater.quitAndInstall(true, true);
    },
  };
}
