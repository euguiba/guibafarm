// Núcleo do app, igual nos dois modos (janela Electron ou contas no Edge):
// perfis, leitura de estado, análise, preços, assistente e automação.
// Cada modo fornece um BrowserHost e expõe `handlers` para a barra lateral.

import { findGame, GAMES } from '../games';
import type { CapturedEvent, GameModule, GameState, PageSnapshot, PriceBook, Recommendation } from '../sdk/types';
import { ActionRunner, type PageControl } from './actions';
import { detectAlerts, type Alert } from './alerts';
import { Assistant } from './assistant';
import { Store, type Profile, type Settings } from './store';
import { isLayoutMode, toAddress, type LayoutMode } from './tiles';
import { ICON_IDS, groupIcon, groupKey, groupLabel } from './groups';

export type { LayoutMode } from './tiles';
export type UiChannel = 'state' | 'recommendations' | 'log' | 'alert';

export interface PageFeeds {
  /** Tráfego de rede dos hosts do jogo. */
  onCaptured(event: CapturedEvent): void;
  /** Texto visível da página, lido periodicamente quando o jogo tem pageReader. */
  onSnapshot(snapshot: PageSnapshot): void;
}

export interface BrowserHost {
  /** Abre a conta numa janela/aba isolada e alimenta os leitores do jogo. */
  open(profile: Profile, game: GameModule, feeds: PageFeeds): Promise<void>;
  close(profileId: string): Promise<void>;
  openIds(): string[];
  setLayout(mode: LayoutMode): void;
  /** Põe a conta em foco: é a que aparece no 1x1 e a que o turbo não desacelera. */
  select(profileId: string): void;
  navigate(profileId: string, url: string): void;
  /** Recarrega uma conta, ou todas quando nenhuma é indicada. */
  reload(profileId?: string): void;
  setMuted(profileId: string, muted: boolean): void;
  setTurbo(on: boolean): void;
  setSidebarCollapsed(collapsed: boolean): void;
  /** Só estas contas entram na grade (as da página de jogo aberta); as outras seguem rodando escondidas. */
  setFilter(profileIds: string[]): void;
  setRender(opts: RenderOptions): void;
  setZoom(profileId: string, zoom: number): void;
  /** Esconde todas as telas enquanto uma janela da interface (configurações) está aberta por cima. */
  setOverlay(hidden: boolean): void;
  metrics(): ViewMetrics;
  page(profileId: string): PageControl | undefined;
}

export interface RenderOptions {
  /** Resolução de todas as telas: 1 é a da tela do PC; 0.5 desenha com metade dos pixels. */
  resolution: number;
  /** Resolução das telas fora de foco quando o turbo está ligado. */
  turboResolution: number;
}

const RESOLUTIONS = [1, 0.75, 0.5];
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;

/** CPU em % da máquina e memória em MB, no total do app e por conta aberta. */
export interface ViewMetrics {
  cpu: number;
  ramMb: number;
  perProfile: Record<string, { cpu: number; ramMb: number }>;
}

/** Módulo "Outro site": conta isolada em qualquer endereço, sem leitura nem análise. */
export const SITE_GAME_ID = 'site';

const ANALYZE_EVERY_MS = 15_000;
const LEVEL_BAND = 10; // "perto do meu nível" no comparador de caçadas
const RECENT_SESSIONS = 15;

export class AppCore {
  readonly store: Store;
  private readonly assistant = new Assistant();
  private readonly recording = new Set<string>();
  private readonly recommendations = new Map<string, Recommendation[]>();
  private readonly actions: ActionRunner;
  private readonly alerts: Alert[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    dataDir: string,
    private readonly host: BrowserHost,
    private readonly emit: (channel: UiChannel, payload: unknown) => void,
  ) {
    this.store = new Store(dataDir);
    this.actions = new ActionRunner((profileId, message) => emit('log', { profileId, message, at: Date.now() }));
  }

  start(): void {
    const settings = this.store.getSettings();
    if (isLayoutMode(settings.layout)) this.host.setLayout(settings.layout);
    this.host.setTurbo(settings.turbo);
    this.host.setSidebarCollapsed(settings.sidebarCollapsed);
    this.host.setRender({ resolution: settings.resolution, turboResolution: settings.turboResolution });
    this.applyFilter();
    this.timer = setInterval(() => {
      for (const id of this.host.openIds()) {
        const profile = this.store.getProfile(id);
        if (profile) this.analyze(profile);
      }
    }, ANALYZE_EVERY_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.actions.stopAll();
    for (const id of this.host.openIds()) await this.host.close(id);
  }

  /** Página aberta: a escolhida, ou a primeira que tiver contas. */
  private activeGroup(): string | undefined {
    const keys = this.store.listProfiles().map(groupKey);
    const chosen = this.store.getSettings().activeGroup;
    return chosen && keys.includes(chosen) ? chosen : keys[0];
  }

  private applyFilter(): void {
    const active = this.activeGroup();
    this.host.setFilter(this.store.listProfiles().filter((p) => groupKey(p) === active).map((p) => p.id));
  }

  private setActiveGroup(key: string): void {
    this.store.setSettings({ activeGroup: key });
    this.applyFilter();
  }

  private gameOf(profile: Profile): GameModule {
    const game = findGame(profile.gameId);
    if (!game) throw new Error(`Jogo desconhecido: ${profile.gameId}`);
    return game;
  }

  private onCaptured(profile: Profile, game: GameModule, event: CapturedEvent): void {
    if (this.recording.has(profile.id)) this.store.record(profile.id, event);
    this.accept(profile, game.reader.onEvent(event, this.store.latestState(profile.id), profile.id));
  }

  private onSnapshot(profile: Profile, game: GameModule, snapshot: PageSnapshot): void {
    if (!game.pageReader) return;
    this.accept(profile, game.pageReader.onSnapshot(snapshot, this.store.latestState(profile.id), profile.id));
  }

  private accept(profile: Profile, next: GameState | undefined): void {
    if (!next) return;
    const prev = this.store.latestState(profile.id);
    this.store.pushState(next);
    this.emit('state', next);
    for (const alert of detectAlerts(prev, next, profile.label)) {
      this.alerts.push(alert);
      if (this.alerts.length > 100) this.alerts.shift();
      this.emit('alert', alert);
    }
  }

  private analyze(profile: Profile): Recommendation[] {
    const game = this.gameOf(profile);
    const recs = game.analyzer?.analyze(this.store.getHistory(profile.id), this.store.getPrices(), Date.now()) ?? [];
    this.recommendations.set(profile.id, recs);
    this.emit('recommendations', { profileId: profile.id, recommendations: recs });
    return recs;
  }

  /** Um handler por canal; os argumentos chegam na ordem que a barra lateral envia. */
  readonly handlers: Record<string, (...args: any[]) => unknown> = {
    'games:list': () => GAMES.map((g) => ({ ...g.manifest, hasAnalyzer: !!g.analyzer, hasHunts: !!g.hunts, hasActor: !!g.actor })),

    'profiles:list': () =>
      this.store
        .listProfiles()
        .map((p) => ({ ...p, group: groupKey(p), open: this.host.openIds().includes(p.id), recording: this.recording.has(p.id) })),

    'profiles:add': (gameId: string, label: string, address?: string) => {
      const game = findGame(gameId);
      if (!game) return { error: 'Jogo desconhecido.' };
      let url: string | undefined;
      if (gameId === SITE_GAME_ID) {
        url = toAddress(String(address ?? ''));
        if (!url) return { error: 'Digite o endereço do site.' };
      }
      const max = game.manifest.maxAccounts;
      if (max !== undefined && this.store.countProfiles(gameId) >= max) {
        return { error: `As regras do ${game.manifest.name} permitem até ${max} contas.` };
      }
      const fallback = url ? new URL(url).hostname.replace(/^www\./, '') : game.manifest.name;
      const profile = this.store.addProfile(gameId, String(label ?? '').trim() || fallback, url);
      const zoom = this.store.getSettings().defaultZoom;
      if (zoom !== 1) this.store.updateProfile(profile.id, { zoom });
      this.setActiveGroup(groupKey(profile));
      return { profile };
    },

    'profiles:remove': async (id: string) => {
      await this.host.close(id);
      this.store.removeProfile(id);
      this.applyFilter();
    },

    'profiles:open': async (id: string) => {
      const profile = this.store.getProfile(id);
      if (!profile) return;
      const game = this.gameOf(profile);
      if (groupKey(profile) !== this.activeGroup()) this.setActiveGroup(groupKey(profile));
      await this.host.open(profile, game, {
        onCaptured: (ev) => this.onCaptured(profile, game, ev),
        onSnapshot: (snap) => this.onSnapshot(profile, game, snap),
      });
    },

    'profiles:close': (id: string) => this.host.close(id),

    'layout:set': (mode: LayoutMode) => {
      if (!isLayoutMode(mode)) return;
      this.store.setSettings({ layout: mode });
      this.host.setLayout(mode);
    },

    'settings:get': (): Settings => this.store.getSettings(),

    'turbo:set': (on: boolean) => {
      this.store.setSettings({ turbo: !!on });
      this.host.setTurbo(!!on);
    },

    'sidebar:set': (collapsed: boolean) => {
      this.store.setSettings({ sidebarCollapsed: !!collapsed });
      this.host.setSidebarCollapsed(!!collapsed);
    },

    'groups:list': () => {
      const settings = this.store.getSettings();
      const open = this.host.openIds();
      const active = this.activeGroup();
      const groups = new Map<string, { key: string; label: string; icon: string; count: number; open: number; max?: number; active: boolean }>();
      for (const p of this.store.listProfiles()) {
        const key = groupKey(p);
        let g = groups.get(key);
        if (!g) {
          g = {
            key,
            label: groupLabel(key, (id) => findGame(id)?.manifest.name, settings.groupNames),
            icon: groupIcon(key, settings.groupIcons),
            count: 0,
            open: 0,
            max: key.startsWith('site:') ? undefined : findGame(key)?.manifest.maxAccounts,
            active: key === active,
          };
          groups.set(key, g);
        }
        g.count++;
        if (open.includes(p.id)) g.open++;
      }
      return { groups: [...groups.values()], icons: ICON_IDS };
    },

    'group:set': (key: string) => this.setActiveGroup(String(key)),

    'group:icon': (key: string, icon: string) => {
      if (!ICON_IDS.includes(icon)) return;
      this.store.setSettings({ groupIcons: { ...this.store.getSettings().groupIcons, [key]: icon } });
    },

    'group:rename': (key: string, name: string) => {
      const names = { ...this.store.getSettings().groupNames };
      const clean = String(name ?? '').trim().slice(0, 60);
      if (clean) names[key] = clean;
      else delete names[key];
      this.store.setSettings({ groupNames: names });
    },

    'profiles:update': (id: string, patch: { label?: string; vocation?: string; icon?: string }) => {
      const profile = this.store.getProfile(id);
      if (!profile) return { error: 'Conta não encontrada.' };
      const roles = this.gameOf(profile).manifest.roles ?? [];
      const label = String(patch.label ?? profile.label).trim().slice(0, 40);
      if (!label) return { error: 'Dê um nome para a conta.' };
      const vocation = roles.some((r) => r.id === patch.vocation) ? patch.vocation : '';
      const icon = patch.icon && ICON_IDS.includes(patch.icon) ? patch.icon : '';
      return { profile: this.store.updateProfile(id, { label, vocation, icon }) };
    },

    'profiles:reorder': (ids: string[]) => {
      if (Array.isArray(ids)) this.store.reorderProfiles(ids.map(String));
    },

    'zoom:set': (id: string, zoom: number) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(Number(zoom) * 100) / 100));
      if (!Number.isFinite(z) || !this.store.updateProfile(id, { zoom: z })) return undefined;
      this.host.setZoom(id, z);
      return z;
    },

    'settings:set': (patch: Partial<Settings>) => {
      const next: Partial<Settings> = {};
      if (RESOLUTIONS.includes(Number(patch.resolution))) next.resolution = Number(patch.resolution);
      if (RESOLUTIONS.includes(Number(patch.turboResolution))) next.turboResolution = Number(patch.turboResolution);
      if (Number(patch.defaultZoom) >= MIN_ZOOM && Number(patch.defaultZoom) <= MAX_ZOOM) next.defaultZoom = Number(patch.defaultZoom);
      if (typeof patch.gpu === 'boolean') next.gpu = patch.gpu;
      const settings = this.store.setSettings(next);
      this.host.setRender({ resolution: settings.resolution, turboResolution: settings.turboResolution });
      return settings;
    },

    'overlay:set': (hidden: boolean) => this.host.setOverlay(!!hidden),

    'view:select': (id: string) => this.host.select(id),
    'view:reload': (id?: string) => this.host.reload(id),
    'view:mute': (id: string, muted: boolean) => this.host.setMuted(id, !!muted),
    'metrics:get': () => this.host.metrics(),

    'nav:go': (id: string, input: string) => {
      const url = toAddress(String(input ?? ''));
      if (!url || !this.host.openIds().includes(id)) return false;
      this.host.navigate(id, url);
      return true;
    },

    'record:set': (id: string, on: boolean) => {
      if (on) this.recording.add(id);
      else this.recording.delete(id);
      return this.store.recordingsDir();
    },

    'state:get': (id: string) => this.store.latestState(id),

    'alerts:list': () => [...this.alerts].reverse(),

    'recommendations:get': (id: string) => {
      const profile = this.store.getProfile(id);
      return profile ? this.analyze(profile) : [];
    },

    'hunts:compare': (id: string, opts: { allAccounts: boolean; nearLevel: boolean }) => {
      const profile = this.store.getProfile(id);
      if (!profile) return undefined;
      const game = this.gameOf(profile);
      if (!game.hunts) return undefined;
      const prices = this.store.getPrices();
      const accounts = opts.allAccounts
        ? this.store.listProfiles().filter((p) => p.gameId === profile.gameId)
        : [profile];
      const level = this.store.latestState(id)?.character.level;
      let sessions = accounts.flatMap((p) => game.hunts!.sessions(this.store.getHistory(p.id), prices));
      if (opts.nearLevel && level !== undefined) {
        sessions = sessions.filter((s) => s.level !== undefined && Math.abs(s.level - level) <= LEVEL_BAND);
      }
      return {
        level,
        levelBand: LEVEL_BAND,
        labels: Object.fromEntries(accounts.map((p) => [p.id, p.label])),
        summaries: game.hunts.summarize(sessions, prices),
        recent: sessions.sort((a, b) => b.end - a.end).slice(0, RECENT_SESSIONS),
      };
    },

    'prices:get': () => this.store.getPrices(),
    'prices:set': (prices: PriceBook) => this.store.setPrices(prices),

    'automation:set': (id: string, on: boolean) => {
      const profile = this.store.getProfile(id);
      return profile ? this.actions.setEnabled(id, this.gameOf(profile), on) : false;
    },

    'action:run': async (id: string, rec: Recommendation) => {
      const profile = this.store.getProfile(id);
      const page = this.host.page(id);
      if (!profile || !page || !rec?.action) return 'Abra a conta primeiro.';
      return this.actions.run(id, this.gameOf(profile), page, rec.action);
    },

    'assistant:ask': async (id: string, question: string) => {
      const profile = this.store.getProfile(id);
      if (!profile) return 'Selecione uma conta.';
      const game = this.gameOf(profile);
      return this.assistant.ask(id, question, {
        gameName: game.manifest.name,
        state: this.store.latestState(id),
        recommendations: this.recommendations.get(id) ?? this.analyze(profile),
        prices: this.store.getPrices(),
        policyNote: game.manifest.policy.note,
      });
    },
  };
}
