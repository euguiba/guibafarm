// Núcleo do app, igual nos dois modos (janela Electron ou contas no Edge):
// perfis, leitura de estado, análise, preços, assistente e automação.
// Cada modo fornece um BrowserHost e expõe `handlers` para a barra lateral.

import { findGame, GAMES } from '../games';
import type { CapturedEvent, GameModule, PriceBook, Recommendation } from '../sdk/types';
import { ActionRunner, type PageControl } from './actions';
import { Assistant } from './assistant';
import { Store, type Profile } from './store';

export type LayoutMode = 'single' | 'grid';
export type UiChannel = 'state' | 'recommendations' | 'log';

export interface BrowserHost {
  /** Abre a conta numa janela/aba isolada e chama onCaptured com o tráfego do jogo. */
  open(profile: Profile, game: GameModule, onCaptured: (event: CapturedEvent) => void): Promise<void>;
  close(profileId: string): Promise<void>;
  openIds(): string[];
  setLayout(mode: LayoutMode): void;
  page(profileId: string): PageControl | undefined;
}

const ANALYZE_EVERY_MS = 15_000;

export class AppCore {
  readonly store: Store;
  private readonly assistant = new Assistant();
  private readonly recording = new Set<string>();
  private readonly recommendations = new Map<string, Recommendation[]>();
  private readonly actions: ActionRunner;
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

  private gameOf(profile: Profile): GameModule {
    const game = findGame(profile.gameId);
    if (!game) throw new Error(`Jogo desconhecido: ${profile.gameId}`);
    return game;
  }

  private onCaptured(profile: Profile, game: GameModule, event: CapturedEvent): void {
    if (this.recording.has(profile.id)) this.store.record(profile.id, event);
    const next = game.reader.onEvent(event, this.store.latestState(profile.id), profile.id);
    if (next) {
      this.store.pushState(next);
      this.emit('state', next);
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
    'games:list': () => GAMES.map((g) => ({ ...g.manifest, hasAnalyzer: !!g.analyzer, hasActor: !!g.actor })),

    'profiles:list': () =>
      this.store
        .listProfiles()
        .map((p) => ({ ...p, open: this.host.openIds().includes(p.id), recording: this.recording.has(p.id) })),

    'profiles:add': (gameId: string, label: string) => {
      const game = findGame(gameId);
      if (!game) return { error: 'Jogo desconhecido.' };
      const max = game.manifest.maxAccounts;
      const warning =
        max !== undefined && this.store.countProfiles(gameId) >= max
          ? `${game.manifest.name} permite até ${max} contas; esta passa do limite.`
          : undefined;
      return { profile: this.store.addProfile(gameId, String(label ?? '').trim() || game.manifest.name), warning };
    },

    'profiles:remove': async (id: string) => {
      await this.host.close(id);
      this.store.removeProfile(id);
    },

    'profiles:open': async (id: string) => {
      const profile = this.store.getProfile(id);
      if (!profile) return;
      const game = this.gameOf(profile);
      await this.host.open(profile, game, (ev) => this.onCaptured(profile, game, ev));
    },

    'profiles:close': (id: string) => this.host.close(id),

    'layout:set': (mode: LayoutMode) => this.host.setLayout(mode),

    'record:set': (id: string, on: boolean) => {
      if (on) this.recording.add(id);
      else this.recording.delete(id);
      return this.store.recordingsDir();
    },

    'state:get': (id: string) => this.store.latestState(id),

    'recommendations:get': (id: string) => {
      const profile = this.store.getProfile(id);
      return profile ? this.analyze(profile) : [];
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
