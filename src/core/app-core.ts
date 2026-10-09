// Núcleo do app, igual nos dois modos (janela Electron ou contas no Edge):
// perfis, leitura de estado, análise, preços, assistente e automação.
// Cada modo fornece um BrowserHost e expõe `handlers` para a barra lateral.

import { findGame, GAMES } from '../games';
import type { CapturedEvent, GameModule, GameState, HuntEvent, PageSnapshot, PriceBook, Recommendation } from '../sdk/types';
import { ActionRunner, type PageControl } from './actions';
import { AlertGate, detectAlerts, type Alert } from './alerts';
import { HuntMeter } from './hunt-meter';
import { Assistant } from './assistant';
import { Store, type Profile, type Settings } from './store';
import { clampRatio, isLayoutMode, toAddress, type LayoutMode, type Ratios } from './tiles';
import { ICON_IDS, groupIcon, groupKey, groupLabel } from './groups';

export type { LayoutMode } from './tiles';
export type UiChannel = 'state' | 'recommendations' | 'log' | 'alert';

export interface PageFeeds {
  /** Tráfego de rede dos hosts do jogo. */
  onCaptured(event: CapturedEvent): void;
  /** Texto visível da página, lido periodicamente quando o jogo tem pageReader. */
  onSnapshot(snapshot: PageSnapshot): void;
  /** Se a rede da conta precisa ser acompanhada agora, e de quais respostas copiar o corpo. */
  network: { active(): boolean; wantsBody(url: string): boolean };
}

export interface BrowserHost {
  /** Abre a conta numa janela/aba isolada e alimenta os leitores do jogo. */
  open(profile: Profile, game: GameModule, feeds: PageFeeds): Promise<void>;
  close(profileId: string): Promise<void>;
  openIds(): string[];
  /** Liga ou desliga a captura de rede da conta (gravação ligada ou desligada). */
  refreshCapture(profileId: string): void;
  setLayout(mode: LayoutMode): void;
  /** Põe a conta em foco: é a que aparece no 1x1 e a que o turbo não desacelera. */
  select(profileId: string): void;
  navigate(profileId: string, url: string): void;
  /** Recarrega uma conta, ou todas quando nenhuma é indicada. */
  reload(profileId?: string): void;
  setMuted(profileId: string, muted: boolean): void;
  setTurbo(on: boolean): void;
  setSidebarCollapsed(collapsed: boolean): void;
  /** Proporção das colunas e linhas da grade (Split e 2x2) da página aberta. */
  setRatios(ratios: Ratios): void;
  /** Modo zen: só os jogos na janela; as barras aparecem ao encostar o mouse no topo. */
  setZen(on: boolean): void;
  setZenReveal(on: boolean): void;
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
  /** Limite de quadros por segundo da conta em foco e das outras (0 = sem limite). */
  fpsFocused?: number;
  fpsOthers?: number;
  /** Pede às páginas menos animações (como a opção "reduzir movimento" do Windows). */
  reduceMotion?: boolean;
}

const RESOLUTIONS = [1, 0.75, 0.5];
const FPS_OPTIONS = [0, 60, 30, 20, 10, 5];
const TELEGRAM_CHECK_MS = 60_000;

function renderOf(s: Settings): RenderOptions {
  return { resolution: s.resolution, turboResolution: s.turboResolution, fpsFocused: s.fpsFocused, fpsOthers: s.fpsOthers, reduceMotion: s.reduceMotion };
}

function short(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}M`;
  if (a >= 1e4) return `${(n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
  return Math.round(n).toLocaleString('pt-BR');
}

function clock(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
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
  private readonly alertGate = new AlertGate();
  private readonly meters = new Map<string, HuntMeter>();
  private timer: NodeJS.Timeout | undefined;
  private telegramTimer: NodeJS.Timeout | undefined;

  constructor(
    dataDir: string,
    private readonly host: BrowserHost,
    private readonly emit: (channel: UiChannel, payload: unknown) => void,
  ) {
    this.store = new Store(dataDir);
    this.actions = new ActionRunner((profileId, message) => emit('log', { profileId, message, at: Date.now() }));
  }

  /** `reopen: false` abre sem as contas que estavam abertas (a abertura anterior caiu). */
  start(opts: { reopen?: boolean } = {}): void {
    const settings = this.store.getSettings();
    if (isLayoutMode(settings.layout)) this.host.setLayout(settings.layout);
    this.host.setTurbo(settings.turbo);
    this.host.setSidebarCollapsed(settings.sidebarCollapsed);
    this.host.setRender(renderOf(settings));
    this.host.setZen(settings.zen);
    this.applyFilter();
    if (opts.reopen !== false) void this.reopen(settings.openProfiles);
    let lastTelegram = Date.now();
    this.telegramTimer = setInterval(() => {
      const { everyMin, token, chatId } = this.store.getSettings().telegram;
      if (!everyMin || !token || !chatId || Date.now() - lastTelegram < everyMin * 60_000) return;
      lastTelegram = Date.now();
      void this.sendTelegram();
    }, TELEGRAM_CHECK_MS);
    this.timer = setInterval(() => {
      for (const id of this.host.openIds()) {
        const profile = this.store.getProfile(id);
        if (profile) this.analyze(profile);
      }
    }, ANALYZE_EVERY_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.telegramTimer) clearInterval(this.telegramTimer);
    this.actions.stopAll();
    for (const m of this.meters.values()) m.finish();
    for (const id of this.host.openIds()) await this.host.close(id);
  }

  /** Abre de novo as contas que estavam abertas quando o app fechou, na mesma ordem. */
  private async reopen(ids: string[]): Promise<void> {
    const selected = this.activeGroup();
    for (const id of ids) {
      const profile = this.store.getProfile(id);
      if (profile) await this.openProfile(profile).catch(() => {});
    }
    if (selected) this.setActiveGroup(selected);
  }

  private async openProfile(profile: Profile): Promise<void> {
    const game = this.gameOf(profile);
    await this.host.open(profile, game, {
      onCaptured: (ev) => this.onCaptured(profile, game, ev),
      onSnapshot: (snap) => this.onSnapshot(profile, game, snap),
      network: {
        active: () => this.recording.has(profile.id) || !!game.network,
        wantsBody: (url) => this.recording.has(profile.id) || !!game.network?.http?.test(url),
      },
    });
    this.rememberOpen();
  }

  private rememberOpen(): void {
    this.store.setSettings({ openProfiles: this.host.openIds() });
  }

  /** Página aberta: a escolhida, ou a primeira que tiver contas. */
  private activeGroup(): string | undefined {
    const keys = this.store.listProfiles().map(groupKey);
    const chosen = this.store.getSettings().activeGroup;
    return chosen && keys.includes(chosen) ? chosen : keys[0];
  }

  private applyFilter(): void {
    const active = this.activeGroup();
    this.host.setRatios((active && this.store.getSettings().ratios[active]) || { col: 0.5, row: 0.5 });
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
    // Jogo sem leitor de rede: o tráfego só é gravado, não vira estado.
    if (!game.network) return;
    this.accept(profile, game.reader.onEvent(event, this.store.latestState(profile.id), profile.id));
    if (game.reader.huntEvents) this.onHunt(profile, game.reader.huntEvents(event, profile.id));
  }

  private meter(profileId: string): HuntMeter {
    let m = this.meters.get(profileId);
    if (!m) {
      m = new HuntMeter(profileId, (run) => this.store.addRun(run));
      this.meters.set(profileId, m);
    }
    return m;
  }

  private onHunt(profile: Profile, events: HuntEvent[]): void {
    if (events.length === 0) return;
    const meter = this.meter(profile.id);
    const level = this.store.latestState(profile.id)?.character.level;
    for (const ev of events) {
      if (ev.kind === 'notice') this.raise({ profileId: profile.id, kind: 'notice', key: ev.key, title: `${profile.label}: ${ev.title}`, body: ev.body, at: ev.at });
      else meter.push(ev, level);
    }
  }

  private raise(alert: Alert): void {
    if (!this.alertGate.allow(alert)) return;
    this.alerts.push(alert);
    if (this.alerts.length > 100) this.alerts.shift();
    this.emit('alert', alert);
  }

  private onSnapshot(profile: Profile, game: GameModule, snapshot: PageSnapshot): void {
    if (!game.pageReader) return;
    this.accept(profile, game.pageReader.onSnapshot(snapshot, this.store.latestState(profile.id), profile.id));
    if (game.pageReader.huntEvents) this.onHunt(profile, game.pageReader.huntEvents(snapshot, profile.id));
  }

  private accept(profile: Profile, next: GameState | undefined): void {
    if (!next) return;
    const prev = this.store.latestState(profile.id);
    this.store.pushState(next);
    this.emit('state', next);
    for (const alert of detectAlerts(prev, next, profile.label)) this.raise(alert);
  }

  /** Ranking das contas abertas da página atual na caçada de agora (dano, XP e lucro por hora). */
  private party() {
    const active = this.activeGroup();
    const now = Date.now();
    const rows = this.host
      .openIds()
      .map((id) => this.store.getProfile(id))
      .filter((p): p is Profile => !!p && groupKey(p) === active)
      .map((p) => ({ id: p.id, label: p.label, view: this.meter(p.id).view(now) }))
      .filter((r) => r.view.run);
    const totalDamage = rows.reduce((s, r) => s + (r.view.run?.damage ?? 0), 0);
    const totalXp = rows.reduce((s, r) => s + (r.view.run?.xp ?? 0), 0);
    return rows
      .map((r) => ({
        id: r.id,
        label: r.label,
        status: r.view.status,
        place: r.view.run?.place,
        activeMs: r.view.run?.activeMs ?? 0,
        damage: r.view.run?.damage ?? 0,
        damageShare: totalDamage ? (r.view.run!.damage / totalDamage) * 100 : 0,
        xpShare: totalXp ? (r.view.run!.xp / totalXp) * 100 : 0,
        perHour: r.view.perHour,
      }))
      .sort((a, b) => b.damage - a.damage || (b.perHour?.xp ?? 0) - (a.perHour?.xp ?? 0));
  }

  /** Texto do resumo: uma linha por conta caçando agora. */
  private summary(): string {
    const lines: string[] = [];
    for (const id of this.host.openIds()) {
      const p = this.store.getProfile(id);
      const v = this.meter(id).view(Date.now());
      if (!p || !v.run) continue;
      const ph = v.perHour;
      const parts = [`XP ${short(v.run.xp)}${ph ? ` (${short(ph.xp)}/h)` : ''}`];
      if (v.run.damage) parts.push(`dano ${short(v.run.damage)}${ph ? ` (${short(ph.damage)}/h)` : ''}`);
      if (v.run.lootValue || v.run.waste) parts.push(`lucro ${short(v.run.lootValue - v.run.waste)}${ph ? ` (${short(ph.profit)}/h)` : ''}`);
      parts.push(`${v.run.kills} abates`);
      lines.push(`• ${p.label}${v.run.place ? ` em ${v.run.place}` : ''} · ${clock(v.run.activeMs)}\n  ${parts.join(' · ')}`);
    }
    return lines.length ? `Navegador Idle · resumo das caçadas\n${lines.join('\n')}` : 'Navegador Idle · nenhuma conta caçando agora.';
  }

  private async sendTelegram(): Promise<string> {
    const { token, chatId } = this.store.getSettings().telegram;
    if (!token || !chatId) return 'Informe o token do bot e o chat nas configurações.';
    try {
      const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: this.summary() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      return body.ok ? 'Resumo enviado.' : `O Telegram recusou: ${body.description ?? res.status}`;
    } catch (err) {
      return `Não deu para falar com o Telegram: ${(err as Error).message}`;
    }
  }

  private analyze(profile: Profile): Recommendation[] {
    const game = this.gameOf(profile);
    const now = Date.now();
    const ctx = { run: this.meters.get(profile.id)?.view(now).run, runs: this.store.listRuns(profile.id), state: this.store.latestState(profile.id) };
    const recs = game.analyzer?.analyze(this.store.getHistory(profile.id), this.store.getPrices(), now, ctx) ?? [];
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
      this.rememberOpen();
      this.applyFilter();
    },

    'profiles:open': async (id: string) => {
      const profile = this.store.getProfile(id);
      if (!profile) return;
      if (groupKey(profile) !== this.activeGroup()) this.setActiveGroup(groupKey(profile));
      await this.openProfile(profile);
    },

    'profiles:close': async (id: string) => {
      this.meters.get(id)?.finish();
      await this.host.close(id);
      this.rememberOpen();
    },

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
      if (typeof patch.streamMode === 'boolean') next.streamMode = patch.streamMode;
      if (FPS_OPTIONS.includes(Number(patch.fpsFocused))) next.fpsFocused = Number(patch.fpsFocused);
      if (FPS_OPTIONS.includes(Number(patch.fpsOthers))) next.fpsOthers = Number(patch.fpsOthers);
      if (typeof patch.reduceMotion === 'boolean') next.reduceMotion = patch.reduceMotion;
      if (typeof patch.openAtLogin === 'boolean') next.openAtLogin = patch.openAtLogin;
      if (patch.telegram && typeof patch.telegram === 'object') {
        next.telegram = {
          token: String(patch.telegram.token ?? '').trim(),
          chatId: String(patch.telegram.chatId ?? '').trim(),
          everyMin: [0, 15, 30, 60, 120].includes(Number(patch.telegram.everyMin)) ? Number(patch.telegram.everyMin) : 0,
        };
      }
      const settings = this.store.setSettings(next);
      this.host.setRender(renderOf(settings));
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
      this.host.refreshCapture(id);
      return this.store.recordingsDir();
    },

    'state:get': (id: string) => this.store.latestState(id),

    'hunt:get': (id: string) => this.meter(id).view(Date.now()),
    'party:get': () => this.party(),
    'telegram:send': async () => this.sendTelegram(),

    'ratios:set': (ratios: { col: number; row: number }) => {
      const active = this.activeGroup();
      const r = { col: clampRatio(ratios?.col), row: clampRatio(ratios?.row) };
      this.host.setRatios(r);
      if (active) this.store.setSettings({ ratios: { ...this.store.getSettings().ratios, [active]: r } });
      return r;
    },
    'zen:set': (on: boolean) => {
      this.store.setSettings({ zen: !!on });
      this.host.setZen(!!on);
    },
    'zen:reveal': (on: boolean) => this.host.setZenReveal(!!on),
    'hunt:pause': (id: string, paused: boolean) => {
      this.meter(id).setPaused(!!paused, Date.now());
      return this.meter(id).view(Date.now());
    },
    'hunt:reset': (id: string) => {
      this.meter(id).reset(Date.now());
      return this.meter(id).view(Date.now());
    },

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
