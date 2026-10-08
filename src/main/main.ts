// Modo Electron: janela com barra lateral e uma aba isolada por conta.

import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppCore } from '../core/app-core';
import { ElectronHost } from './views';

// Mesma pasta de dados no "npm start" e no app instalado, para não perder contas e logins.
app.setPath('userData', join(app.getPath('appData'), 'navegador-idle'));

// Aceleração de hardware desligada nas configurações (PC com placa de vídeo fraca ou com problema).
try {
  const saved = JSON.parse(readFileSync(join(app.getPath('userData'), 'settings.json'), 'utf8')) as { gpu?: boolean };
  if (saved.gpu === false) app.disableHardwareAcceleration();
} catch {
  // sem configurações salvas ainda
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'Navegador Idle',
    backgroundColor: '#070b14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const send = (channel: string, payload: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const core = new AppCore(app.getPath('userData'), new ElectronHost(win, send), (channel, payload) => {
    send(channel, payload);
    if (channel === 'alert' && Notification.isSupported()) {
      const { title, body } = payload as { title: string; body: string };
      new Notification({ title, body }).show();
    }
  });
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
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
