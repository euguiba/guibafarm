// Leitura do texto visível do Huntera: painel do personagem e log de combate.
// Só lê; nada aqui clica ou digita no jogo.
//
// Os padrões do painel vêm do MultiAccountIdle (MIT, Alex Chang) e os do log de
// combate do HunteraPartyAnalyzer (redslugah). Os de morte ainda não foram vistos
// num log real e podem precisar de ajuste.

import type { GameState, HuntEvent, PageReader, PageSnapshot } from '../../sdk/types';

function near(text: string, anchor: RegExp, span: number, re: RegExp): string | undefined {
  const i = text.search(anchor);
  if (i < 0) return undefined;
  return text.slice(i, i + span).match(re)?.[1];
}

/** "1.234" ou "1,234" (milhar) -> 1234; "12,5" ou "12.5" (decimal) -> 12.5 */
export function parseGameNumber(raw: string): number {
  const s = raw.trim().replace(/\s/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  return Number(s.replace(',', '.'));
}

export interface PanelFields {
  level?: number;
  capacityOz?: number;
  staminaMin?: number;
  xpPercent?: number;
  disconnected: boolean;
}

export function parsePanel(text: string): PanelFields {
  const lv = text.match(/\blv\.?\s*:?\s*(\d+)/i);
  const cap = near(text, /Capacidade|Capacity/i, 60, /([\d.,]+)\s*oz/i);
  const sta = near(text, /Stamina/i, 60, /(\d{1,2}:\d{2})\s*h?/i);
  const xp = near(text, /Experi[êe]ncia|\bEXP\b|Experience/i, 120, /([\d.,]+)\s*%/);
  let staminaMin: number | undefined;
  if (sta) {
    const [h, m] = sta.split(':').map(Number);
    staminaMin = h * 60 + m;
  }
  return {
    level: lv ? Number(lv[1]) : undefined,
    capacityOz: cap ? parseGameNumber(cap) : undefined,
    staminaMin,
    xpPercent: xp ? Number(xp.replace(',', '.')) : undefined,
    disconnected: /(voc[êe] foi desconectad|desconectado do servidor|connection lost|disconnected from|conex[ãa]o perdida)/i.test(text),
  };
}

const DAMAGE = [
  /^(?:Critical!\s+)?You hit .+ for (\d{1,3}(?:[,.]\d{3})+|\d+)/i,
  /^(?:Crítico!\s+)?Você acertou .+ causando (\d{1,3}(?:[,.]\d{3})+|\d+)/i,
];
const XP = [/^Você ganhou (\d{1,3}(?:\.\d{3})*) de experiência\.?$/i, /^You gained (\d{1,3}(?:,\d{3})*) experience points\.?$/i];
const DEATH = [/^Você morreu/i, /^You are dead/i, /^You died/i];

export interface LogTotals {
  xp: number;
  damage: number;
  hits: number;
  biggestHit: number;
  deaths: number;
}

export function parseLog(lines: string[]): LogTotals {
  const totals: LogTotals = { xp: 0, damage: 0, hits: 0, biggestHit: 0, deaths: 0 };
  for (const raw of lines) {
    const line = raw.trim();
    const xp = XP.map((re) => re.exec(line)).find(Boolean);
    if (xp) {
      totals.xp += Number(xp[1].replace(/[.,]/g, ''));
      continue;
    }
    const hit = DAMAGE.map((re) => re.exec(line)).find(Boolean);
    if (hit) {
      const n = Number(hit[1].replace(/[.,]/g, ''));
      totals.damage += n;
      totals.hits += 1;
      totals.biggestHit = Math.max(totals.biggestHit, n);
      continue;
    }
    if (DEATH.some((re) => re.test(line))) totals.deaths += 1;
  }
  return totals;
}

/** Fatos de caça das linhas novas do log de combate: cada XP ganha conta como um abate. */
export function logHuntEvents(lines: string[], at: number): HuntEvent[] {
  const out: HuntEvent[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const xp = XP.map((re) => re.exec(line)).find(Boolean);
    if (xp) {
      out.push({ kind: 'kill', at, xp: Number(xp[1].replace(/[.,]/g, '')) });
      continue;
    }
    const hit = DAMAGE.map((re) => re.exec(line)).find(Boolean);
    if (hit) out.push({ kind: 'damage', at, amount: Number(hit[1].replace(/[.,]/g, '')) });
  }
  return out;
}

export const hunteraPageReader: PageReader = {
  logContainer: '.chat-combat-log',
  logLine: '.combat-text',
  // Chat (inclusive o de combate, lido à parte linha a linha) fora do texto do painel.
  ignore: '[class*="chat"], [class*="Chat"]',
  huntEvents: (snap) => logHuntEvents(snap.logLines, snap.at),
  onSnapshot(snap: PageSnapshot, previous: GameState | undefined, profileId: string): GameState | undefined {
    const panel = parsePanel(snap.text);
    const log = parseLog(snap.logLines);
    const prevRes = previous?.resources ?? {};
    const next: GameState = {
      gameId: 'huntera',
      profileId,
      at: snap.at,
      character: { ...previous?.character },
      resources: { ...prevRes },
      location: previous?.location,
      inventory: previous?.inventory,
    };
    if (panel.level !== undefined) next.character.level = panel.level;
    if (panel.capacityOz !== undefined) next.resources.capacity_oz = panel.capacityOz;
    if (panel.staminaMin !== undefined) next.resources.stamina_min = panel.staminaMin;
    if (panel.xpPercent !== undefined) next.resources.xp_pct = panel.xpPercent;
    next.resources.disconnected = panel.disconnected ? 1 : 0;
    // Totais acumulados do log desde que a conta foi aberta no navegador.
    next.resources.xp_log = (prevRes.xp_log ?? 0) + log.xp;
    next.resources.damage_log = (prevRes.damage_log ?? 0) + log.damage;
    next.resources.hits_log = (prevRes.hits_log ?? 0) + log.hits;
    next.resources.biggest_hit = Math.max(prevRes.biggest_hit ?? 0, log.biggestHit);
    next.resources.deaths = (prevRes.deaths ?? 0) + log.deaths;

    const same =
      previous !== undefined &&
      previous.character.level === next.character.level &&
      Object.keys(next.resources).every((k) => previous.resources[k] === next.resources[k]);
    return same ? undefined : next;
  },
};
