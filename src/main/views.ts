// Modo Electron: uma WebContentsView por conta, cada uma na sua partição. A área à
// direita da barra lateral mostra as contas abertas em grade (1x1, Split, 2x2, 3x3);
// cada célula tem um cabeçalho desenhado pela interface logo acima da página.

import { app, shell, WebContentsView, type BaseWindow, type WebContents } from 'electron';
import { cpus } from 'node:os';
import type { PageControl } from '../core/actions';
import type { BrowserHost, PageFeeds, ViewMetrics } from '../core/app-core';
import type { Profile } from '../core/store';
import { computeCells, type Cell, type LayoutMode } from '../core/tiles';
import type { GameModule } from '../sdk/types';
import { attachCapture } from './capture';
import { watchPage } from './page-watch';

export const SIDEBAR_WIDTH = 340;
/** Altura da barra de cima (botões de grade, medidores e barra de endereço); igual ao CSS. */
export const TOPBAR_HEIGHT = 104;
/** Altura do cabeçalho de cada tela; igual ao CSS. */
export const TILE_HEAD = 30;
const PAD = 10;
const GAP = 10;
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
}

export interface TileInfo extends Cell {
  head: number;
  label?: string;
  game?: string;
  url?: string;
  muted?: boolean;
  focused?: boolean;
}

export type HostChannel = 'tiles';

export class ElectronHost implements BrowserHost {
  private entries = new Map<string, Entry>();
  private selected: string | undefined;
  private mode: LayoutMode = '1x1';
  private turbo = false;

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
      const entry: Entry = { view, profile, game, detach, url, muted: false, cpuRate: 1 };
      this.entries.set(profile.id, entry);
      const onNav = (_e: unknown, next: string) => {
        entry.url = next;
        this.emitTiles();
      };
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
    if (this.selected === profileId) this.selected = this.entries.keys().next().value;
    this.layout();
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
    const area = { x: SIDEBAR_WIDTH, y: TOPBAR_HEIGHT, width: Math.max(0, width - SIDEBAR_WIDTH), height: Math.max(0, height - TOPBAR_HEIGHT) };
    return computeCells(this.mode, this.openIds(), this.selected, area, { pad: PAD, gap: GAP });
  }

  private layout(): void {
    const cells = this.cells();
    const shown = new Set<string>();
    for (const cell of cells) {
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

  /** Turbo: telas escondidas ficam em segundo plano, as fora de foco rodam mais devagar e sem som. */
  private applyPower(id: string, entry: Entry, visible: boolean): void {
    const wc = entry.view.webContents;
    const focused = id === this.selected;
    wc.setBackgroundThrottling(this.turbo && !visible);
    wc.setAudioMuted(entry.muted || (this.turbo && !focused));
    const rate = this.turbo && !focused ? TURBO_CPU_RATE : 1;
    if (rate !== entry.cpuRate) {
      entry.cpuRate = rate;
      setCpuRate(wc, rate);
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
      };
    });
    this.onUi('tiles', {
      mode: this.mode,
      turbo: this.turbo,
      selected: this.selected,
      open: this.entries.size,
      tiles,
    });
  }
}

function setCpuRate(wc: WebContents, rate: number): void {
  const dbg = wc.debugger;
  if (!dbg.isAttached()) {
    try {
      dbg.attach('1.3');
    } catch {
      return;
    }
  }
  dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
}
