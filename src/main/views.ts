// Modo Electron: uma WebContentsView por conta, cada uma na sua partição. A área à
// direita da barra lateral mostra as contas abertas em grade (1x1, Split, 2x2, 3x3);
// cada célula tem um cabeçalho desenhado pela interface logo acima da página.

import { app, screen, shell, WebContentsView, type BaseWindow, type WebContents } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { PageControl } from '../core/actions';
import type { BrowserHost, PageFeeds, RenderOptions, ViewMetrics } from '../core/app-core';
import type { Profile } from '../core/store';
import { computeCells, type Cell, type LayoutMode } from '../core/tiles';
import type { GameModule } from '../sdk/types';
import { attachCapture, type CaptureControl } from './capture';
import { watchPage } from './page-watch';

/** Largura da barra lateral aberta (faixa de páginas + lista de contas) e recolhida (só a faixa); igual ao CSS. */
export const SIDEBAR_WIDTH = 304;
export const SIDEBAR_COLLAPSED = 56;
/** Altura da barra de cima (grade, endereço, medidores e turbo numa linha só); igual ao CSS. */
export const TOPBAR_HEIGHT = 52;
/** Altura do cabeçalho de cada tela; igual ao CSS. */
export const TILE_HEAD = 28;
const PAD = 6;
const GAP = 6;
/** No turbo, as telas fora de foco rodam o JavaScript nesta fração da velocidade. */
const TURBO_CPU_RATE = 3;
/** De quanto em quanto tempo as contas devolvem memória que não estão usando. */
const TRIM_EVERY_MS = 3 * 60_000;
/** Tela que travou ou fechou sozinha (falta de memória, por exemplo) recarrega até tantas vezes por minuto. */
const MAX_AUTO_RELOADS = 3;

/** Por quanto tempo um cookie de sessão (que o navegador apagaria ao fechar) fica guardado. */
const KEEP_SESSION_COOKIES_DAYS = 30;

/** sessionStorage de cada origem aberta na conta: alguns jogos guardam o login só ali. */
type SessionSnapshot = Record<string, Record<string, string>>;

interface Entry {
  view: WebContentsView;
  profile: Profile;
  game: GameModule;
  detach: Array<() => void>;
  capture?: CaptureControl;
  url: string;
  muted: boolean;
  cpuRate: number;
  zoom: number;
  /** Resolução aplicada agora (1 = nativa). */
  scale: number;
  visible: boolean;
  crashes: number[];
  retries: number;
  retryTimer?: NodeJS.Timeout;
}

export interface TileInfo extends Cell {
  head: number;
  label?: string;
  game?: string;
  url?: string;
  muted?: boolean;
  focused?: boolean;
  zoom?: number;
  scale?: number;
}

export type HostChannel = 'tiles';

export class ElectronHost implements BrowserHost {
  private entries = new Map<string, Entry>();
  private keptSessions = new WeakSet<Electron.Session>();
  private selected: string | undefined;
  private mode: LayoutMode = '1x1';
  private turbo = false;
  private sidebar = SIDEBAR_WIDTH;
  private filter: Set<string> | undefined;
  private overlay = false;
  private render: RenderOptions = { resolution: 1, turboResolution: 0.5 };

  constructor(
    private readonly win: BaseWindow,
    private readonly onUi: (channel: HostChannel, payload: unknown) => void,
    /** Pasta onde fica o sessionStorage salvo de cada conta. */
    private readonly sessionDir?: string,
  ) {
    win.on('resize', () => this.layout());
    setInterval(() => this.trimMemory(), TRIM_EVERY_MS).unref();
    // No Windows, maximizar, restaurar ou esconder telas às vezes deixava a interface do app
    // (barra lateral e de cima) preta enquanto o jogo seguia desenhado: pede um quadro novo dela.
    for (const ev of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen', 'show'] as const) {
      win.on(ev as 'show', () => this.repaintSoon());
    }
  }

  async open(profile: Profile, game: GameModule, feeds: PageFeeds): Promise<void> {
    if (!this.entries.has(profile.id)) {
      const view = new WebContentsView({
        // spellcheck desligado: o corretor carrega dicionários em cada conta e jogo não precisa dele.
        webPreferences: { partition: profile.partition, contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false },
      });
      view.setBackgroundColor('#070b14');
      this.win.contentView.addChildView(view);
      const wc = view.webContents;
      const detach: Array<() => void> = [];
      let capture: CaptureControl | undefined;
      if (game.manifest.policy.read) {
        capture = attachCapture(wc, game.manifest.hosts, (ev) => feeds.onCaptured(ev), feeds.network);
        detach.push(capture.detach);
        if (game.pageReader) detach.push(watchPage(wc, game.manifest.hosts, game.pageReader, (snap) => feeds.onSnapshot(snap)));
      }
      const url = profile.url ?? game.manifest.startUrl;
      const entry: Entry = { view, profile, game, detach, capture, url, muted: false, cpuRate: 1, zoom: profile.zoom ?? 1, scale: 1, visible: false, crashes: [], retries: 0 };
      this.entries.set(profile.id, entry);
      // Página que fechou sozinha (falta de memória, travamento) deixava a tela preta: recarrega.
      wc.on('render-process-gone', (_e, details) => {
        if (details.reason === 'clean-exit' || !this.entries.has(profile.id)) return;
        const now = Date.now();
        entry.crashes = entry.crashes.filter((t) => now - t < 60_000).concat(now);
        console.warn(`[tela] ${profile.label}: página fechou (${details.reason})`);
        if (entry.crashes.length <= MAX_AUTO_RELOADS) setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000);
      });
      const onNav = (_e: unknown, next: string) => {
        entry.url = next;
        this.emitTiles();
      };
      // O Chromium guarda o zoom por site; reaplica o da conta a cada página carregada.
      wc.on('did-finish-load', () => {
        wc.setZoomFactor(entry.zoom);
        entry.retries = 0;
      });
      // Reconexão: página que não carregou (internet caiu, servidor fora) tenta de novo sozinha,
      // esperando cada vez mais (5 s, 15 s, 30 s, depois de minuto em minuto).
      wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
        if (!isMainFrame || code === -3) return; // -3: navegação cancelada, não é falha
        const wait = [5, 15, 30][entry.retries] ?? 60;
        entry.retries++;
        console.warn(`[tela] ${profile.label}: não carregou (${desc}); tentando de novo em ${wait} s`);
        clearTimeout(entry.retryTimer);
        entry.retryTimer = setTimeout(() => !wc.isDestroyed() && void wc.loadURL(failedUrl || entry.url), wait * 1000);
      });
      wc.on('did-navigate', onNav);
      wc.on('did-navigate-in-page', (e, next, isMainFrame) => isMainFrame && onNav(e, next));
      // Links que abrem nova janela vão para o navegador padrão, fora da partição da conta.
      wc.setWindowOpenHandler(({ url: target }) => {
        void shell.openExternal(target);
        return { action: 'deny' };
      });
      this.keepSessionCookies(wc.session);
      await this.restoreSession(profile.id, wc);
      void wc.loadURL(url);
    }
    this.selected = profile.id;
    this.layout();
  }

  async close(profileId: string): Promise<void> {
    const entry = this.entries.get(profileId);
    if (!entry) return;
    clearTimeout(entry.retryTimer);
    await this.saveSession(profileId, entry.view.webContents);
    for (const d of entry.detach) d();
    this.win.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
    this.entries.delete(profileId);
    if (this.selected === profileId) this.selected = this.shownIds()[0];
    this.layout();
  }

  /**
   * Pede às contas que soltem caches (imagens decodificadas, fontes, lixo do JavaScript), como o
   * Chrome faz quando falta memória. A conta em foco só limpa o leve, para não engasgar.
   */
  private trimMemory(): void {
    for (const [id, entry] of this.entries) {
      const wc = entry.view.webContents;
      if (wc.isDestroyed() || wc.isLoading()) continue;
      const level = !entry.visible ? 'critical' : 'moderate';
      if (id === this.selected && entry.visible && this.mode === '1x1') continue;
      sendCdp(wc, 'Memory.simulatePressureNotification', { level });
    }
  }

  refreshCapture(profileId: string): void {
    this.entries.get(profileId)?.capture?.update();
  }

  setFilter(profileIds: string[]): void {
    this.filter = new Set(profileIds);
    if (!this.selected || !this.filter.has(this.selected)) this.selected = this.shownIds()[0];
    this.layout();
  }

  setRender(opts: RenderOptions): void {
    this.render = opts;
    this.layout();
  }

  setZoom(profileId: string, zoom: number): void {
    const entry = this.entries.get(profileId);
    if (!entry) return;
    entry.zoom = zoom;
    entry.view.webContents.setZoomFactor(zoom);
    this.emitTiles();
  }

  setOverlay(hidden: boolean): void {
    this.overlay = hidden;
    this.layout();
  }

  /** Contas abertas da página de jogo atual, na ordem em que foram abertas. */
  private shownIds(): string[] {
    return this.openIds().filter((id) => !this.filter || this.filter.has(id));
  }

  openIds(): string[] {
    return [...this.entries.keys()];
  }

  setLayout(mode: LayoutMode): void {
    this.mode = mode;
    this.layout();
  }

  select(profileId: string): void {
    if (!this.entries.has(profileId)) return;
    this.selected = profileId;
    this.layout();
  }

  navigate(profileId: string, url: string): void {
    void this.entries.get(profileId)?.view.webContents.loadURL(url);
  }

  reload(profileId?: string): void {
    for (const [id, entry] of this.entries) if (!profileId || id === profileId) entry.view.webContents.reload();
  }

  setMuted(profileId: string, muted: boolean): void {
    const entry = this.entries.get(profileId);
    if (!entry) return;
    entry.muted = muted;
    this.layout();
  }

  setTurbo(on: boolean): void {
    this.turbo = on;
    this.layout();
  }

  setSidebarCollapsed(collapsed: boolean): void {
    this.sidebar = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_WIDTH;
    this.layout();
  }

  metrics(): ViewMetrics {
    const cores = Math.max(1, cpus().length);
    const byPid = new Map(app.getAppMetrics().map((m) => [m.pid, m]));
    let cpu = 0;
    let kb = 0;
    for (const m of byPid.values()) {
      cpu += m.cpu.percentCPUUsage;
      kb += m.memory.workingSetSize;
    }
    const perProfile: ViewMetrics['perProfile'] = {};
    for (const [id, entry] of this.entries) {
      const m = byPid.get(entry.view.webContents.getOSProcessId());
      if (m) perProfile[id] = { cpu: m.cpu.percentCPUUsage / cores, ramMb: m.memory.workingSetSize / 1024 };
    }
    return { cpu: cpu / cores, ramMb: kb / 1024, perProfile };
  }

  /** Reenvia a grade para a interface (depois de ela recarregar). */
  refresh(): void {
    this.layout();
  }

  private repaintTimer: NodeJS.Timeout | undefined;

  /** Redesenha logo e de novo um pouco depois (o Windows às vezes só aceita o segundo quadro). */
  private repaintSoon(): void {
    clearTimeout(this.repaintTimer);
    setTimeout(() => this.repaint(), 60);
    this.repaintTimer = setTimeout(() => this.repaint(), 400);
  }

  /** Depois de a placa de vídeo reiniciar, as telas podem ficar pretas: redesenha todas. */
  repaint(): void {
    const ui = (this.win as BaseWindow & { webContents?: WebContents }).webContents;
    if (ui && !ui.isDestroyed()) ui.invalidate();
    for (const entry of this.entries.values()) if (!entry.view.webContents.isDestroyed()) entry.view.webContents.invalidate();
  }

  /** Grava logins e dados das contas abertas no disco (ao fechar o app e de tempos em tempos). */
  async persist(): Promise<void> {
    const sessions = new Set<Electron.Session>();
    for (const [id, entry] of this.entries) {
      await this.saveSession(id, entry.view.webContents);
      sessions.add(entry.view.webContents.session);
    }
    for (const ses of sessions) {
      await ses.cookies.flushStore().catch(() => {});
      ses.flushStorageData();
    }
  }

  /**
   * Muitos jogos guardam o login num cookie "de sessão", que o navegador apaga ao fechar. Na partição
   * da conta, esse cookie ganha validade de alguns dias, como o "manter conectado" de um site.
   */
  private keepSessionCookies(ses: Electron.Session): void {
    if (this.keptSessions.has(ses)) return;
    this.keptSessions.add(ses);
    ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
      if (removed || !cookie.session || !cookie.domain) return;
      const host = cookie.domain.replace(/^\./, '');
      const { session: _s, hostOnly, ...rest } = cookie;
      void ses.cookies
        .set({
          ...rest,
          url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`,
          domain: hostOnly ? undefined : cookie.domain,
          expirationDate: Date.now() / 1000 + KEEP_SESSION_COOKIES_DAYS * 86_400,
        })
        .catch(() => {});
    });
  }

  private sessionFile(profileId: string): string | undefined {
    return this.sessionDir && join(this.sessionDir, `${profileId.replace(/[^\w-]/g, '')}.json`);
  }

  private async saveSession(profileId: string, wc: WebContents): Promise<void> {
    const file = this.sessionFile(profileId);
    if (!file || wc.isDestroyed()) return;
    const snapshot: SessionSnapshot = {};
    let read = false;
    for (const frame of wc.mainFrame?.framesInSubtree ?? []) {
      try {
        const res = (await frame.executeJavaScript(
          `(() => { try { const o = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); o[k] = sessionStorage.getItem(k); } return [location.origin, o]; } catch { return null; } })()`,
        )) as [string, Record<string, string>] | null;
        if (res) read = true;
        if (res && res[0] !== 'null' && Object.keys(res[1]).length) snapshot[res[0]] = { ...snapshot[res[0]], ...res[1] };
      } catch {
        // frame ainda carregando ou já fechado
      }
    }
    try {
      if (Object.keys(snapshot).length) {
        mkdirSync(this.sessionDir!, { recursive: true });
        writeFileSync(file, JSON.stringify(snapshot));
      } else if (read) rmSync(file, { force: true });
    } catch {
      // sem permissão de escrita: segue sem salvar
    }
  }

  /** Devolve o sessionStorage salvo só no primeiro carregamento, antes dos scripts do jogo rodarem. */
  private async restoreSession(profileId: string, wc: WebContents): Promise<void> {
    const file = this.sessionFile(profileId);
    if (!file) return;
    let snapshot: SessionSnapshot;
    try {
      snapshot = JSON.parse(readFileSync(file, 'utf8')) as SessionSnapshot;
    } catch {
      return;
    }
    const source = `(() => { try { const s = ${JSON.stringify(snapshot)}[location.origin]; if (!s || sessionStorage.length) return; for (const k in s) sessionStorage.setItem(k, s[k]); } catch {} })();`;
    try {
      // O depurador só responde depois que a aba tem uma página; a em branco é instantânea.
      await wc.loadURL('about:blank');
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Page.enable');
      const added = wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source }) as Promise<{ identifier: string }>;
      const { identifier } = await Promise.race([added, new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('timeout')), 2000))]);
      // Só vale para a primeira página: se a pessoa sair da conta depois, o login não volta sozinho.
      wc.once('did-finish-load', () => {
        if (!wc.isDestroyed()) wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
      });
    } catch {
      // sem depurador: a conta abre sem o sessionStorage salvo
    }
  }

  page(profileId: string): PageControl | undefined {
    const wc = this.entries.get(profileId)?.view.webContents;
    if (!wc) return undefined;
    return {
      evaluate: (js) => wc.executeJavaScript(js, true),
      click: async (x, y) => {
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      },
    };
  }

  private cells(): Cell[] {
    const { width, height } = this.win.getContentBounds();
    const area = { x: this.sidebar, y: TOPBAR_HEIGHT, width: Math.max(0, width - this.sidebar), height: Math.max(0, height - TOPBAR_HEIGHT) };
    return computeCells(this.mode, this.shownIds(), this.selected, area, { pad: PAD, gap: GAP });
  }

  private layout(): void {
    const cells = this.cells();
    const shown = new Set<string>();
    for (const cell of this.overlay ? [] : cells) {
      const entry = cell.profileId ? this.entries.get(cell.profileId) : undefined;
      if (!entry) continue;
      shown.add(cell.profileId!);
      entry.view.setVisible(true);
      // Tela que volta a aparecer às vezes ficava preta até mexer na janela: pede um quadro novo.
      if (!entry.visible) setTimeout(() => !entry.view.webContents.isDestroyed() && entry.view.webContents.invalidate(), 50);
      entry.visible = true;
      entry.view.setBounds({ x: cell.x, y: cell.y + TILE_HEAD, width: cell.width, height: Math.max(0, cell.height - TILE_HEAD) });
    }
    for (const [id, entry] of this.entries) {
      if (!shown.has(id)) {
        entry.view.setVisible(false);
        entry.visible = false;
      }
      this.applyPower(id, entry, shown.has(id));
    }
    this.emitTiles(cells);
    this.repaintSoon();
  }

  /**
   * Resolução e turbo. Todas as telas desenham na resolução escolhida; com o turbo, as fora de foco
   * caem para a resolução do turbo, rodam o JavaScript mais devagar e ficam sem som, e as escondidas
   * (outras páginas ou fora da grade) ficam em segundo plano.
   */
  private applyPower(id: string, entry: Entry, visible: boolean): void {
    const wc = entry.view.webContents;
    const focused = id === this.selected;
    const background = this.turbo && !focused;
    // Conta escondida (outra página ou fora da grade) roda em segundo plano, como uma aba de fundo
    // do Chrome: o jogo segue no servidor e a página gasta menos CPU e memória.
    wc.setBackgroundThrottling(!visible);
    wc.setAudioMuted(entry.muted || background);
    const rate = background ? TURBO_CPU_RATE : 1;
    if (rate !== entry.cpuRate) {
      entry.cpuRate = rate;
      sendCdp(wc, 'Emulation.setCPUThrottlingRate', { rate });
    }
    const scale = background ? Math.min(this.render.resolution, this.render.turboResolution) : this.render.resolution;
    if (scale !== entry.scale) {
      entry.scale = scale;
      if (scale === 1) sendCdp(wc, 'Emulation.clearDeviceMetricsOverride', {});
      else {
        // Mesmo tamanho de página, com menos pixels desenhados; o Chromium amplia a imagem final.
        const native = screen.getDisplayMatching(this.win.getBounds()).scaleFactor;
        sendCdp(wc, 'Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: native * scale, mobile: false });
      }
    }
  }

  private emitTiles(cells = this.cells()): void {
    const tiles: TileInfo[] = cells.map((cell) => {
      const entry = cell.profileId ? this.entries.get(cell.profileId) : undefined;
      return {
        ...cell,
        head: TILE_HEAD,
        label: entry?.profile.label,
        game: entry?.game.manifest.name,
        url: entry?.url,
        muted: entry?.muted,
        focused: cell.profileId !== undefined && cell.profileId === this.selected,
        zoom: entry?.zoom,
        scale: entry?.scale,
      };
    });
    this.onUi('tiles', {
      mode: this.mode,
      turbo: this.turbo,
      selected: this.selected,
      open: this.shownIds().length,
      overlay: this.overlay,
      tiles,
    });
  }
}

function sendCdp(wc: WebContents, method: string, params: Record<string, unknown>): void {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) {
    try {
      dbg.attach('1.3');
    } catch {
      return;
    }
  }
  dbg.sendCommand(method, params).catch(() => {});
}
