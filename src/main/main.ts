// Modo Electron: janela com barra lateral e uma aba isolada por conta.

import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { join } from 'node:path';
import { AppCore } from '../core/app-core';
import { ElectronHost } from './views';

// Mesma pasta de dados no "npm start" e no app instalado, para não perder contas e logins.
app.setPath('userData', join(app.getPath('appData'), 'navegador-idle'));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Navegador Idle',
    backgroundColor: '#070b14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const core = new AppCore(app.getPath('userData'), new ElectronHost(win), (channel, payload) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
    if (channel === 'alert' && Notification.isSupported()) {
      const { title, body } = payload as { title: string; body: string };
      new Notification({ title, body }).show();
    }
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
