// Analyzer de hunt de uma conta: começa sozinho quando a conta entra numa caça (ou no primeiro
// abate), soma XP, loot e gastos, e conta só o tempo caçando de verdade. Pode pausar e zerar.
// Só lê o que o jogo mostra ou envia; nada aqui age no jogo.

import type { HuntEvent, HuntRun } from '../sdk/types';

/** Sem nenhum fato de caça por mais que isso, a conta parou: esse tempo não entra na conta. */
export const IDLE_GAP_MS = 2 * 60_000;
/** Caçada menor que isso não vai para o histórico. */
export const MIN_RUN_MS = 5 * 60_000;

export type HuntStatus = 'fora' | 'caçando' | 'parado' | 'pausado';

export interface HuntView {
  status: HuntStatus;
  run?: HuntRun;
  /** Por hora, sobre o tempo caçando. */
  perHour?: { xp: number; loot: number; waste: number; profit: number; kills: number; damage: number };
}

function emptyRun(profileId: string, at: number, place?: string): HuntRun {
  return {
    profileId,
    place,
    start: at,
    last: at,
    activeMs: 0,
    kills: 0,
    xp: 0,
    damage: 0,
    lootValue: 0,
    waste: 0,
    catches: 0,
    catchTries: 0,
    shinies: 0,
    loot: {},
    spent: {},
  };
}

function add(bag: Record<string, { qty: number; value: number }>, name: string, qty: number, value: number): void {
  const cur = bag[name] ?? { qty: 0, value: 0 };
  bag[name] = { qty: cur.qty + qty, value: cur.value + value };
}

export class HuntMeter {
  private run: HuntRun | undefined;
  private paused = false;
  private place: string | undefined;

  constructor(
    private readonly profileId: string,
    /** Caçada que terminou (trocou de local ou foi zerada) com tempo suficiente para comparar. */
    private readonly onFinish: (run: HuntRun) => void = () => {},
  ) {}

  /** Soma um fato; devolve true se algo mudou. */
  push(ev: HuntEvent, level?: number): boolean {
    if (ev.kind === 'notice') return false;
    if (ev.kind === 'enter') {
      this.place = ev.place;
      if (this.run && this.run.place === ev.place) return false;
      this.finish();
      this.run = emptyRun(this.profileId, ev.at, ev.place);
      if (level !== undefined) this.run.level = level;
      return true;
    }
    if (this.paused) return false;
    if (!this.run) this.run = emptyRun(this.profileId, ev.at, this.place);
    const run = this.run;
    if (level !== undefined) run.level ??= level;
    run.activeMs += Math.max(0, Math.min(ev.at - run.last, IDLE_GAP_MS));
    run.last = Math.max(run.last, ev.at);
    switch (ev.kind) {
      case 'kill':
        run.kills += 1;
        run.xp += ev.xp;
        if (ev.shiny) run.shinies += 1;
        break;
      case 'loot':
        run.lootValue += ev.value;
        add(run.loot, ev.name, ev.qty, ev.value);
        break;
      case 'spend':
        run.waste += ev.value;
        add(run.spent, ev.name, ev.qty, ev.value);
        break;
      case 'catch':
        run.catchTries += 1;
        if (ev.success) run.catches += 1;
        if (ev.success && ev.shiny) run.shinies += 1;
        break;
      case 'damage':
        run.damage += ev.amount;
        break;
    }
    return true;
  }

  setPaused(paused: boolean, now: number): void {
    if (paused === this.paused) return;
    this.paused = paused;
    // Ao continuar, o relógio volta a contar de agora; o tempo pausado fica de fora.
    if (!paused && this.run) this.run.last = now;
  }

  /** Zera a caçada atual (guarda no histórico se valer) e começa outra no mesmo local. */
  reset(now: number): void {
    this.finish();
    this.run = undefined;
    this.paused = false;
    if (this.place) this.run = emptyRun(this.profileId, now, this.place);
  }

  /** Fecha a caçada atual, por exemplo ao fechar a conta. */
  finish(): void {
    if (this.run && this.run.activeMs >= MIN_RUN_MS) this.onFinish({ ...this.run, loot: { ...this.run.loot }, spent: { ...this.run.spent } });
    this.run = undefined;
  }

  view(now: number): HuntView {
    const run = this.run;
    if (!run) return { status: this.paused ? 'pausado' : 'fora' };
    const idle = now - run.last > IDLE_GAP_MS;
    const status: HuntStatus = this.paused ? 'pausado' : idle ? 'parado' : 'caçando';
    const ms = run.activeMs + (status === 'caçando' ? Math.max(0, now - run.last) : 0);
    const h = ms / 3_600_000;
    const perHour =
      ms >= 60_000
        ? {
            xp: run.xp / h,
            loot: run.lootValue / h,
            waste: run.waste / h,
            profit: (run.lootValue - run.waste) / h,
            kills: run.kills / h,
            damage: run.damage / h,
          }
        : undefined;
    return { status, run: { ...run, activeMs: ms }, perHour };
  }
}
