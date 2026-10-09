// Persistência simples em arquivos dentro da pasta de dados do app:
// perfis e preços em JSON, histórico de estado e gravações de tráfego em JSONL.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CapturedEvent, GameState, HuntRun, PriceBook } from '../sdk/types';

export interface Profile {
  id: string;
  gameId: string;
  label: string;
  /** Partição persistente do Electron: cookies e storage isolados por conta. */
  partition: string;
  createdAt: number;
  /** Endereço inicial próprio, usado pelas contas de "Outro site". */
  url?: string;
  /** Zoom da página desta conta (1 = 100%). */
  zoom?: number;
  /** Vocação/classe no jogo (id de GameRole), quando o jogo tem. */
  vocation?: string;
  /** Ícone escolhido para a conta (id do conjunto de ícones). */
  icon?: string;
}

export interface Settings {
  layout: string;
  turbo: boolean;
  /** Barra lateral recolhida: só a faixa estreita com as páginas e contas. */
  sidebarCollapsed: boolean;
  /** Página de jogo aberta na barra lateral; as telas mostram só as contas dela. */
  activeGroup?: string;
  groupIcons: Record<string, string>;
  /** Nome próprio de cada página, ex.: "Huntera – Equipe Principal". */
  groupNames: Record<string, string>;
  /** Resolução de todas as telas (1 = nativa da tela do PC, 0.75, 0.5). */
  resolution: number;
  /** Resolução das telas fora de foco quando o turbo está ligado. */
  turboResolution: number;
  /** Zoom das contas novas. */
  defaultZoom: number;
  /** Aceleração de hardware (GPU); vale depois de reabrir o app. */
  gpu: boolean;
  /** Modo stream: esconde nomes das contas e endereços na tela do app. */
  streamMode: boolean;
  /** Contas que estavam abertas; voltam abertas na próxima vez que o app iniciar. */
  openProfiles: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  layout: '1x1',
  turbo: false,
  sidebarCollapsed: false,
  groupIcons: {},
  groupNames: {},
  resolution: 1,
  turboResolution: 0.5,
  defaultZoom: 1,
  gpu: true,
  openProfiles: [],
  streamMode: false,
};

const HISTORY_LIMIT = 5_000; // estados em memória por perfil
const RUNS_LIMIT = 200; // caçadas lidas do histórico por perfil
const MAX_RECORDED_BODY = 200_000;

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  private profiles: Profile[];
  private prices: PriceBook;
  private settings: Settings;
  private history = new Map<string, GameState[]>();

  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'state'), { recursive: true });
    mkdirSync(join(dir, 'recordings'), { recursive: true });
    mkdirSync(join(dir, 'hunts'), { recursive: true });
    this.profiles = readJson<Profile[]>(join(dir, 'profiles.json'), []);
    this.prices = readJson<PriceBook>(join(dir, 'prices.json'), { currencyBrlPer1k: {}, itemBrl: {} });
    this.settings = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(join(dir, 'settings.json'), {}) };
  }

  listProfiles(): Profile[] {
    return [...this.profiles];
  }

  getProfile(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  addProfile(gameId: string, label: string, url?: string): Profile {
    const id = randomUUID().slice(0, 8);
    const profile: Profile = { id, gameId, label, partition: `persist:${gameId}-${id}`, createdAt: Date.now() };
    if (url) profile.url = url;
    this.profiles.push(profile);
    this.saveProfiles();
    return profile;
  }

  updateProfile(id: string, patch: Partial<Pick<Profile, 'label' | 'zoom' | 'vocation' | 'icon'>>): Profile | undefined {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) return undefined;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === '') delete (profile as unknown as Record<string, unknown>)[key];
      else (profile as unknown as Record<string, unknown>)[key] = value;
    }
    this.saveProfiles();
    return profile;
  }

  /** Nova ordem das contas (as que não vierem na lista ficam no fim, na ordem de antes). */
  reorderProfiles(ids: string[]): void {
    const rank = new Map(ids.map((id, i) => [id, i]));
    this.profiles = this.profiles
      .map((p, i) => ({ p, k: rank.get(p.id) ?? ids.length + i }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.p);
    this.saveProfiles();
  }

  removeProfile(id: string): void {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.history.delete(id);
    this.saveProfiles();
  }

  countProfiles(gameId: string): number {
    return this.profiles.filter((p) => p.gameId === gameId).length;
  }

  getSettings(): Settings {
    return { ...this.settings };
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch };
    writeFileSync(join(this.dir, 'settings.json'), JSON.stringify(this.settings, null, 2));
    return this.getSettings();
  }

  getPrices(): PriceBook {
    return structuredClone(this.prices);
  }

  setPrices(prices: PriceBook): void {
    this.prices = prices;
    writeFileSync(join(this.dir, 'prices.json'), JSON.stringify(prices, null, 2));
  }

  getHistory(profileId: string): GameState[] {
    let h = this.history.get(profileId);
    if (!h) {
      h = this.loadHistory(profileId);
      this.history.set(profileId, h);
    }
    return h;
  }

  latestState(profileId: string): GameState | undefined {
    return this.getHistory(profileId).at(-1);
  }

  pushState(state: GameState): void {
    const h = this.getHistory(state.profileId);
    h.push(state);
    if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
    appendFileSync(this.statePath(state.profileId), JSON.stringify(state) + '\n');
  }

  record(profileId: string, event: CapturedEvent): void {
    const day = new Date(event.at).toISOString().slice(0, 10);
    const body = event.body.length > MAX_RECORDED_BODY ? event.body.slice(0, MAX_RECORDED_BODY) : event.body;
    appendFileSync(join(this.dir, 'recordings', `${profileId}-${day}.jsonl`), JSON.stringify({ ...event, body }) + '\n');
  }

  /** Caçadas encerradas pelo analyzer de hunt, as mais recentes por último. */
  listRuns(profileId: string): HuntRun[] {
    const path = join(this.dir, 'hunts', `${profileId}.jsonl`);
    if (!existsSync(path)) return [];
    const out: HuntRun[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-RUNS_LIMIT)) {
      try {
        out.push(JSON.parse(line) as HuntRun);
      } catch {
        // linha cortada; ignora
      }
    }
    return out;
  }

  addRun(run: HuntRun): void {
    appendFileSync(join(this.dir, 'hunts', `${run.profileId}.jsonl`), JSON.stringify(run) + '\n');
  }

  recordingsDir(): string {
    return join(this.dir, 'recordings');
  }

  private statePath(profileId: string): string {
    return join(this.dir, 'state', `${profileId}.jsonl`);
  }

  private loadHistory(profileId: string): GameState[] {
    const path = this.statePath(profileId);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_LIMIT);
    const out: GameState[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as GameState);
      } catch {
        // linha cortada por um encerramento abrupto; ignora
      }
    }
    return out;
  }

  private saveProfiles(): void {
    writeFileSync(join(this.dir, 'profiles.json'), JSON.stringify(this.profiles, null, 2));
  }
}
