// Persistência simples em arquivos dentro da pasta de dados do app:
// perfis e preços em JSON, histórico de estado e gravações de tráfego em JSONL.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CapturedEvent, GameState, PriceBook } from '../sdk/types';

export interface Profile {
  id: string;
  gameId: string;
  label: string;
  /** Partição persistente do Electron: cookies e storage isolados por conta. */
  partition: string;
  createdAt: number;
}

const HISTORY_LIMIT = 5_000; // estados em memória por perfil
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
  private history = new Map<string, GameState[]>();

  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'state'), { recursive: true });
    mkdirSync(join(dir, 'recordings'), { recursive: true });
    this.profiles = readJson<Profile[]>(join(dir, 'profiles.json'), []);
    this.prices = readJson<PriceBook>(join(dir, 'prices.json'), { currencyBrlPer1k: {}, itemBrl: {} });
  }

  listProfiles(): Profile[] {
    return [...this.profiles];
  }

  getProfile(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  addProfile(gameId: string, label: string): Profile {
    const id = randomUUID().slice(0, 8);
    const profile: Profile = { id, gameId, label, partition: `persist:${gameId}-${id}`, createdAt: Date.now() };
    this.profiles.push(profile);
    this.saveProfiles();
    return profile;
  }

  removeProfile(id: string): void {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.history.delete(id);
    this.saveProfiles();
  }

  countProfiles(gameId: string): number {
    return this.profiles.filter((p) => p.gameId === gameId).length;
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
