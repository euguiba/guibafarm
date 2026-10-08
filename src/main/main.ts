// Processo principal: janela com barra lateral, uma aba isolada por conta,
// captura de rede ligada ao leitor do jogo, analisador e assistente.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { findGame, GAMES } from '../games';
import type { CapturedEvent, GameModule, PriceBook, Recommendation } from '../sdk/types';
import { ActionRunner } from './actions';
import { Assistant } from './assistant';
import { attachCapture } from './capture';
import { Store, type Profile } from './store';
import { ViewManager, type LayoutMode } from './views';

const ANALYZE_EVERY_MS = 15_000;

let win: BrowserWindow;
let store: Store;
let views: ViewManager;
const assistant = new Assistant();
const recording = new Set<string>();
const detachers = new Map<string, () => void>();
const recommendations = new Map<string, Recommendation[]>();
const actions = new ActionRunner((profileId, message) => send('log', { profileId, message, at: Date.now() }));

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function gameOf(profile: Profile): GameModule {
  const game = findGame(profile.gameId);
  if (!game) throw new Error(`Jogo desconhecido: ${profile.gameId}`);
  return game;
}

function onCaptured(profile: Profile, game: GameModule, event: CapturedEvent): void {
  if (recording.has(profile.id)) store.record(profile.id, event);
  const next = game.reader.onEvent(event, store.latestState(profile.id), profile.id);
  if (next) {
    store.pushState(next);
    send('state', next);
  }
}

function analyze(profile: Profile): Recommendation[] {
  const game = gameOf(profile);
  const recs = game.analyzer?.analyze(store.getHistory(profile.id), store.getPrices(), Date.now()) ?? [];
  recommendations.set(profile.id, recs);
  send('recommendations', { profileId: profile.id, recommendations: recs });
  return recs;
}

function openProfile(profile: Profile): void {
  const game = gameOf(profile);
  views.open(profile, game.manifest.startUrl, (view) => {
    if (game.manifest.policy.read) {
      detachers.set(profile.id, attachCapture(view.webContents, game.manifest.hosts, (ev) => onCaptured(profile, game, ev)));
    }
    // Links que abrem nova janela vão para o navegador padrão, fora da partição da conta.
    view.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

function registerIpc(): void {
  ipcMain.handle('games:list', () => GAMES.map((g) => ({ ...g.manifest, hasAnalyzer: !!g.analyzer, hasActor: !!g.actor })));

  ipcMain.handle('profiles:list', () =>
    store.listProfiles().map((p) => ({ ...p, open: views.openIds().includes(p.id), recording: recording.has(p.id) })),
  );

  ipcMain.handle('profiles:add', (_e, gameId: string, label: string) => {
    const game = findGame(gameId);
    if (!game) return { error: 'Jogo desconhecido.' };
    const max = game.manifest.maxAccounts;
    const warning =
      max !== undefined && store.countProfiles(gameId) >= max
        ? `${game.manifest.name} permite até ${max} contas; esta passa do limite.`
        : undefined;
    return { profile: store.addProfile(gameId, label.trim() || game.manifest.name), warning };
  });

  ipcMain.handle('profiles:remove', (_e, id: string) => {
    detachers.get(id)?.();
    detachers.delete(id);
    views.close(id);
    store.removeProfile(id);
  });

  ipcMain.handle('profiles:open', (_e, id: string) => {
    const profile = store.getProfile(id);
    if (profile) openProfile(profile);
  });

  ipcMain.handle('profiles:close', (_e, id: string) => {
    detachers.get(id)?.();
    detachers.delete(id);
    views.close(id);
  });

  ipcMain.handle('layout:set', (_e, mode: LayoutMode) => views.setMode(mode));

  ipcMain.handle('record:set', (_e, id: string, on: boolean) => {
    if (on) recording.add(id);
    else recording.delete(id);
    return store.recordingsDir();
  });

  ipcMain.handle('state:get', (_e, id: string) => store.latestState(id));

  ipcMain.handle('recommendations:get', (_e, id: string) => {
    const profile = store.getProfile(id);
    return profile ? analyze(profile) : [];
  });

  ipcMain.handle('prices:get', () => store.getPrices());
  ipcMain.handle('prices:set', (_e, prices: PriceBook) => store.setPrices(prices));

  ipcMain.handle('automation:set', (_e, id: string, on: boolean) => {
    const profile = store.getProfile(id);
    if (!profile) return false;
    return actions.setEnabled(id, gameOf(profile), on);
  });

  ipcMain.handle('action:run', async (_e, id: string, rec: Recommendation) => {
    const profile = store.getProfile(id);
    const view = views.get(id);
    if (!profile || !view || !rec.action) return 'Abra a conta primeiro.';
    return actions.run(id, gameOf(profile), view.webContents, rec.action);
  });

  ipcMain.handle('assistant:ask', async (_e, id: string, question: string) => {
    const profile = store.getProfile(id);
    if (!profile) return 'Selecione uma conta.';
    const game = gameOf(profile);
    return assistant.ask(id, question, {
      gameName: game.manifest.name,
      state: store.latestState(id),
      recommendations: recommendations.get(id) ?? analyze(profile),
      prices: store.getPrices(),
      policyNote: game.manifest.policy.note,
    });
  });
}

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'Navegador Idle',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  views = new ViewManager(win);
  registerIpc();
  void win.loadFile(join(__dirname, '..', 'ui', 'index.html'));

  setInterval(() => {
    for (const id of views.openIds()) {
      const profile = store.getProfile(id);
      if (profile) analyze(profile);
    }
  }, ANALYZE_EVERY_MS);
});

app.on('window-all-closed', () => {
  actions.stopAll();
  for (const detach of detachers.values()) detach();
  app.quit();
});
