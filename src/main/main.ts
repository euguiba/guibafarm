// Modo Electron: janela com barra lateral e uma aba isolada por conta.
// Se o Windows bloquear o Electron (Controle Inteligente de Aplicativos), use `npm run start:edge`.

import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { AppCore } from '../core/app-core';
import { ElectronHost } from './views';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Navegador Idle',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const core = new AppCore(app.getPath('userData'), new ElectronHost(win), (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  });
  for (const [channel, handler] of Object.entries(core.handlers)) {
    ipcMain.handle(channel, (_e, ...args) => handler(...args));
  }
  core.start();
  void win.loadFile(join(__dirname, '..', 'ui', 'index.html'));

  app.on('window-all-closed', () => {
    void core.stop().finally(() => app.quit());
  });
});
