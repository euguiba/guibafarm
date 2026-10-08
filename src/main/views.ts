// Modo Electron: uma WebContentsView por conta, cada uma na sua partição. A área à
// direita da barra lateral mostra as contas abertas em grade (1x1, Split, 2x2, 3x3);
// cada célula tem um cabeçalho desenhado pela interface logo acima da página.

import { app, screen, shell, WebContentsView, type BaseWindow, type WebContents } from 'electron';
import { cpus } from 'node:os';
import type { PageControl } from '../core/actions';
import type { BrowserHost, PageFeeds, RenderOptions, ViewMetrics } from '../core/app-core';
import type { Profile } from '../core/store';
import { computeCells, type Cell, type LayoutMode } from '../core/tiles';
import type { GameModule } from '../sdk/types';
import { attachCapture } from './capture';
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

interface Entry {
  view: WebContentsView;
  profile: Profile;
  game: GameModule;
  detach: Array<() => void>;
  url: string;
  muted: boolean;
  cpuRate: number;
  zoom: number;
  /** Resolução aplicada agora (1 = nativa). */
  scale: number;
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
  ) {
    win.on('resize', () => this.layout());
  }

  async open(profile: Profile, game: GameModule, feeds: PageFeeds): Promise<void> {
    if (!this.entries.has(profile.id)) {
      const view = new WebContentsView({
        // Sem throttling por padrão: conta escondida continua rodando normal. O turbo liga.
        webPreferences: { partition: profile.partition, contextIsolation: true, sandbox: true, backgroundThrottling: false },
      });
      view.setBackgroundColor('#070b14');
      this.win.contentView.addChildView(view);
      const wc = view.webContents;
      const detach: Array<() => void> = [];
      if (game.manifest.policy.read) {
        detach.push(attachCapture(wc, game.manifest.hosts, (ev) => feeds.onCaptured(ev)));
        if (game.pageReader) detach.push(watchPage(wc, game.manifest.hosts, game.pageReader, (snap) => feeds.onSnapshot(snap)));
      }
      const url = profile.url ?? game.manifest.startUrl;
      const entry: Entry = { view, profile, game, detach, url, muted: false, cpuRate: 1, zoom: profile.zoom ?? 1, scale: 1 };
      this.entries.set(profile.id, entry);
      const onNav = (_e: unknown, next: string) => {
        entry.url = next;
        this.emitTiles();
      };
      // O Chromium guarda o zoom por site; reaplica o da conta a cada página carregada.
      wc.on('did-finish-load', () => wc.setZoomFactor(entry.zoom));
      wc.on('did-navigate', onNav);
      wc.on('did-navigate-in-page', (e, next, isMainFrame) => isMainFrame && onNav(e, next));
      // Links que abrem nova janela vão para o navegador padrão, fora da partição da conta.
      wc.setWindowOpenHandler(({ url: target }) => {
        void shell.openExternal(target);
        return { action: 'deny' };
      });
      void wc.loadURL(url);
    }
    this.selected = profile.id;
    this.layout();
  }

  async close(profileId: string): Promise<void> {
    const entry = this.entries.get(profileId);
    if (!entry) return;
    for (const d of entry.detach) d();
    this.win.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
    this.entries.delete(profileId);
    if (this.selected === profileId) this.selected = this.shownIds()[0];
    this.layout();
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
      entry.view.setBounds({ x: cell.x, y: cell.y + TILE_HEAD, width: cell.width, height: Math.max(0, cell.height - TILE_HEAD) });
    }
    for (const [id, entry] of this.entries) {
      if (!shown.has(id)) entry.view.setVisible(false);
      this.applyPower(id, entry, shown.has(id));
    }
    this.emitTiles(cells);
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
    wc.setBackgroundThrottling(this.turbo && !visible);
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
