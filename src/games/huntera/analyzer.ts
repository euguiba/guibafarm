// Analisador do Huntera: mede ouro e XP por hora em cada caça a partir do histórico
// de estados da conta e recomenda onde caçar.

import type { Analyzer, GameState, PriceBook, Recommendation } from '../../sdk/types';

const MIN_SEGMENT_MS = 5 * 60_000;
const IDLE_ALERT_MS = 10 * 60_000;
const SWITCH_THRESHOLD = 0.7; // sugerir troca se a caça atual render menos que 70% da melhor
const UNKNOWN_LOCATION = 'local desconhecido';
const HOUR_MS = 3_600_000;

export interface HuntStats {
  location: string;
  durationMs: number;
  experience: number;
  gold: number;
  xpPerHour: number;
  goldPerHour: number;
  brlPerHour?: number;
}

interface Segment {
  location: string;
  first: GameState;
  last: GameState;
}

function segmentsByLocation(history: GameState[]): Segment[] {
  const segments: Segment[] = [];
  for (const state of history) {
    const location = state.location ?? UNKNOWN_LOCATION;
    const current = segments.at(-1);
    if (current && current.location === location) current.last = state;
    else segments.push({ location, first: state, last: state });
  }
  return segments;
}

function delta(first: number | undefined, last: number | undefined): number {
  return first === undefined || last === undefined ? 0 : last - first;
}

export function huntStats(history: GameState[], prices: PriceBook): HuntStats[] {
  const sorted = [...history].sort((a, b) => a.at - b.at);
  const totals = new Map<string, { durationMs: number; experience: number; gold: number }>();
  for (const seg of segmentsByLocation(sorted)) {
    const durationMs = seg.last.at - seg.first.at;
    if (durationMs < MIN_SEGMENT_MS) continue;
    const t = totals.get(seg.location) ?? { durationMs: 0, experience: 0, gold: 0 };
    t.durationMs += durationMs;
    t.experience += delta(seg.first.character.experience, seg.last.character.experience);
    t.gold += delta(seg.first.resources.gold, seg.last.resources.gold);
    totals.set(seg.location, t);
  }
  const goldRate = prices.currencyBrlPer1k.gold;
  return [...totals.entries()].map(([location, t]) => {
    const hours = t.durationMs / HOUR_MS;
    const goldPerHour = t.gold / hours;
    return {
      location,
      durationMs: t.durationMs,
      experience: t.experience,
      gold: t.gold,
      xpPerHour: t.experience / hours,
      goldPerHour,
      brlPerHour: goldRate === undefined ? undefined : (goldPerHour / 1000) * goldRate,
    };
  });
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('pt-BR');
}

function brl(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function lastExperienceChange(sorted: GameState[]): number | undefined {
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i].character.experience !== sorted[i - 1].character.experience) return sorted[i].at;
  }
  return undefined;
}

export const hunteraAnalyzer: Analyzer = {
  analyze(history, prices, now) {
    const recs: Recommendation[] = [];
    const sorted = [...history].sort((a, b) => a.at - b.at);
    const stats = huntStats(sorted, prices);
    const priced = stats.every((s) => s.brlPerHour !== undefined);
    const money = (s: HuntStats) => (priced ? s.brlPerHour! : s.goldPerHour);

    const byMoney = [...stats].sort((a, b) => money(b) - money(a));
    const byXp = [...stats].sort((a, b) => b.xpPerHour - a.xpPerHour);
    const bestMoney = byMoney.at(0);
    const bestXp = byXp.at(0);

    if (bestMoney && bestMoney.goldPerHour > 0) {
      recs.push({
        id: 'best-profit',
        title: `Melhor caça para lucro: ${bestMoney.location}`,
        detail: priced
          ? `${fmt(bestMoney.goldPerHour)} ouro/h, cerca de ${brl(bestMoney.brlPerHour!)}/h, medido em ${fmt(bestMoney.durationMs / 60_000)} min.`
          : `${fmt(bestMoney.goldPerHour)} ouro/h líquido, medido em ${fmt(bestMoney.durationMs / 60_000)} min. Informe o preço do ouro para ver em reais.`,
        score: money(bestMoney),
        unit: priced ? 'R$/h' : 'ouro/h',
      });
    }
    if (bestXp && bestXp.xpPerHour > 0) {
      recs.push({
        id: 'best-xp',
        title: `Melhor caça para XP: ${bestXp.location}`,
        detail: `${fmt(bestXp.xpPerHour)} XP/h, medido em ${fmt(bestXp.durationMs / 60_000)} min.`,
        score: bestXp.xpPerHour,
        unit: 'XP/h',
      });
    }

    const current = sorted.at(-1);
    const currentStats = current && stats.find((s) => s.location === (current.location ?? UNKNOWN_LOCATION));
    if (bestMoney && currentStats && currentStats !== bestMoney && money(currentStats) < money(bestMoney) * SWITCH_THRESHOLD) {
      recs.push({
        id: 'switch-hunt',
        title: `Trocar ${currentStats.location} por ${bestMoney.location}`,
        detail: `A caça atual rende ${fmt((money(currentStats) / money(bestMoney)) * 100)}% da melhor medida.`,
        score: money(bestMoney) - money(currentStats),
        unit: priced ? 'R$/h a mais' : 'ouro/h a mais',
      });
    }

    const first = sorted.at(0);
    const lastXp = lastExperienceChange(sorted) ?? first?.at;
    if (first && lastXp !== undefined && now - first.at >= IDLE_ALERT_MS && now - lastXp >= IDLE_ALERT_MS) {
      recs.push({
        id: 'idle-alert',
        title: 'Sem ganho de XP',
        detail: `Nenhuma XP nova há ${fmt((now - lastXp) / 60_000)} min. Confira se o personagem morreu, ficou sem poções ou parou de caçar.`,
        score: Number.MAX_SAFE_INTEGER,
        unit: 'alerta',
      });
    }

    return recs.sort((a, b) => b.score - a.score);
  },
};
