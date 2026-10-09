// Modo Electron: janela com barra lateral e uma aba isolada por conta.

import { app, BrowserWindow, crashReporter, ipcMain, Notification } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFY_KINDS, type Alert } from '../core/alerts';
import { AppCore } from '../core/app-core';
import { log, markClosed, markRunning, watchProcesses } from './diagnostics';
import { startUpdater } from './updater';
import { ElectronHost } from './views';

// Mesma pasta de dados no "npm start" e no app instalado, para não perder contas e logins.
app.setPath('userData', join(app.getPath('appData'), 'navegador-idle'));

// No Windows, o Chromium às vezes acha que a janela está coberta e para de desenhar a interface
// (tela preta com o jogo ainda aparecendo). Essa detecção fica desligada.
// Também ficam desligados recursos do Chrome que só gastam memória aqui: o processo reserva
// para abrir páginas mais rápido e o cache de voltar/avançar, que guarda páginas antigas inteiras.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,SpareRendererForSitePerProcess,BackForwardCache');

watchProcesses();
// Falhas graves do Chromium ficam salvas em userData/Crashpad (só no PC, nada é enviado).
crashReporter.start({ uploadToServer: false });
/** A abertura anterior caiu: esta abre sem reabrir as contas, para não cair de novo no mesmo ponto. */
const lastRunCrashed = markRunning();
log(`abrindo versão ${app.getVersion()}${lastRunCrashed ? ' (a anterior não fechou normalmente)' : ''}`);
app.on('quit', () => {
  log('fechado normalmente');
  markClosed();
});

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
  const host = new ElectronHost(win, send, join(app.getPath('userData'), 'sessions'));
  const core = new AppCore(app.getPath('userData'), host, (channel, payload) => {
    send(channel, payload);
    // Notificação do Windows só para o que pede ação (morte, queda, auto-catch parado);
    // nível e stamina ficam só na lista de alertas do app.
    if (channel === 'alert' && Notification.isSupported() && NOTIFY_KINDS.has((payload as Alert).kind)) {
      const { title, body } = payload as { title: string; body: string };
      new Notification({ title, body }).show();
    }
  });
  const updater = startUpdater((status) => send('update', status));
  ipcMain.handle('update:status', () => updater.status());
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });
  // Abrir com o Windows: só faz sentido no app instalado (no "npm start" abriria o Electron puro).
  const syncLogin = () => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: core.store.getSettings().openAtLogin });
  };
  const setSettings = core.handlers['settings:set'];
  core.handlers['settings:set'] = (...args: unknown[]) => {
    const out = setSettings(...args);
    syncLogin();
    return out;
  };
  syncLogin();
  for (const [channel, handler] of Object.entries(core.handlers)) {
    ipcMain.handle(channel, (_e, ...args) => handler(...args));
  }
  core.start({ reopen: !lastRunCrashed });
  if (lastRunCrashed && Notification.isSupported()) {
    new Notification({
      title: 'Navegador Idle',
      body: 'O app fechou sozinho da última vez. As contas não foram reabertas automaticamente; abra pela barra lateral.',
    }).show();
  }
  void win.loadFile(join(__dirname, '..', 'ui', 'index.html'));

  // Logins: grava cookies e sessões das contas a cada minuto, ao fechar e quando o Windows desliga,
  // para não precisar entrar de novo nos jogos se o app for fechado à força.
  const saver = setInterval(() => void host.persist(), 60_000);
  win.on('session-end', () => void host.persist());
  // Interface do app caiu (falta de memória, placa de vídeo): recarrega em vez de ficar preta.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 1000);
  });
  let frozen: NodeJS.Timeout | undefined;
  win.webContents.on('unresponsive', () => {
    frozen = setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 5000);
  });
  win.webContents.on('responsive', () => clearTimeout(frozen));
  // Depois de recarregar, a interface precisa das posições das telas de novo.
  win.webContents.on('did-finish-load', () => host.refresh());
  let saved = false;
  win.on('close', (ev) => {
    if (saved) return;
    ev.preventDefault();
    clearInterval(saver);
    const timeout = new Promise((r) => setTimeout(r, 4000));
    void Promise.race([host.persist(), timeout]).finally(() => {
      saved = true;
      win.close();
    });
  });

  // Placa de vídeo reiniciou: redesenha as telas. Se cair de novo várias vezes, desliga a aceleração
  // de hardware para a próxima abertura, que é a causa comum de tela preta em PC fraco.
  let gpuCrashes = 0;
  app.on('child-process-gone', (_e, details) => {
    if (details.type !== 'GPU' || details.reason === 'clean-exit') return;
    gpuCrashes++;
    setTimeout(() => host.repaint(), 1500);
    // A interface do app não guarda nada importante (tudo fica no processo principal): recarregar é seguro.
    setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 2000);
    if (gpuCrashes === 3) {
      const file = join(app.getPath('userData'), 'settings.json');
      try {
        const settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        writeFileSync(file, JSON.stringify({ ...settings, gpu: false }, null, 2));
      } catch {
        // sem configurações salvas
      }
      if (Notification.isSupported()) {
        new Notification({
          title: 'Placa de vídeo instável',
          body: 'A aceleração de hardware foi desligada para evitar tela preta. Reabra o app para aplicar.',
        }).show();
      }
    }
  });

  app.on('window-all-closed', () => {
    void core.stop().finally(() => app.quit());
  });
});
