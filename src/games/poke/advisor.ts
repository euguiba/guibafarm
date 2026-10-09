// Recomendações do Poke Idle World: onde farmar, o que vender e o que comprar.
// Usa o que a conta já mediu (caçadas do analyzer) e os catálogos do próprio jogo.
// Só sugere; quem decide e joga é a pessoa.

import type { AnalyzeContext, Analyzer, HuntRun, Recommendation } from '../../sdk/types';
import type { CreatureInfo, HuntInfo, PokeData } from './data';

const HOUR = 3_600_000;
/** Bônus do tipo do dia (o jogo anuncia +20% de XP e loot). */
const TYPE_DAY_BONUS = 1.2;
/** Estoque que dura menos que isso no ritmo atual vira recomendação de compra. */
const LOW_STOCK_HOURS = 3;

function fmt(n: number): string {
  return Math.round(n).toLocaleString('pt-BR');
}

function hours(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

interface Estimate {
  hunt: HuntInfo;
  creature: CreatureInfo;
  loot: number;
  xp: number;
  bonus: boolean;
}

/** Caças liberadas para o nível, com loot e XP esperados por abate pelo catálogo. */
export function catalogHunts(data: PokeData, level: number | undefined): Estimate[] {
  const out: Estimate[] = [];
  for (const hunt of data.hunts.values()) {
    if (level !== undefined && hunt.level > level) continue;
    const creature = data.creatureOfHunt(hunt);
    if (!creature) continue;
    const bonus = !!data.typeOfDay && creature.types.includes(data.typeOfDay.type);
    const k = bonus ? TYPE_DAY_BONUS : 1;
    out.push({ hunt, creature, loot: data.lootPerKill(creature) * k, xp: creature.experience * k, bonus });
  }
  return out;
}

function perHour(run: HuntRun) {
  const h = run.activeMs / HOUR;
  return { xp: run.xp / h, profit: (run.lootValue - run.waste) / h, kills: run.kills / h };
}

export function pokeAdvisor(data: PokeData): Analyzer {
  return {
    analyze(_history, _prices, now, ctx?: AnalyzeContext): Recommendation[] {
      const recs: Recommendation[] = [];
      const profileId = ctx?.state?.profileId ?? ctx?.run?.profileId ?? ctx?.runs[0]?.profileId;
      const acc = profileId ? data.account(profileId) : undefined;
      const level = acc?.level ?? ctx?.state?.character.level;

      // Alerta: auto-catch parado por falta de pokébola.
      if (acc?.outOfBall) {
        recs.push({
          id: 'no-ball',
          kind: 'alerta',
          title: `Auto-Catch parado: acabou ${acc.outOfBall}`,
          detail: 'Compre mais ou escolha outra pokébola no Auto-Helper.',
          score: Number.MAX_SAFE_INTEGER,
          unit: 'alerta',
        });
      }

      // Farm medido: melhores caçadas desta conta (5 min ou mais).
      const runs = (ctx?.runs ?? []).filter((r) => r.place && r.activeMs >= 5 * 60_000);
      const byPlace = new Map<string, HuntRun>();
      for (const r of runs) {
        const cur = byPlace.get(r.place!);
        if (!cur) byPlace.set(r.place!, { ...r });
        else {
          cur.activeMs += r.activeMs;
          cur.xp += r.xp;
          cur.lootValue += r.lootValue;
          cur.waste += r.waste;
          cur.kills += r.kills;
        }
      }
      const measured = [...byPlace.values()];
      const bestProfit = [...measured].sort((a, b) => perHour(b).profit - perHour(a).profit)[0];
      const bestXp = [...measured].sort((a, b) => perHour(b).xp - perHour(a).xp)[0];
      if (bestProfit && perHour(bestProfit).profit > 0) {
        recs.push({
          id: 'best-profit',
          kind: 'farm',
          title: `Mais lucro medido: ${bestProfit.place}`,
          detail: `${fmt(perHour(bestProfit).profit)} gold/h de lucro (loot menos pokébolas e poções), em ${hours(bestProfit.activeMs)} medidos.`,
          score: perHour(bestProfit).profit,
          unit: 'gold/h',
        });
      }
      if (bestXp && perHour(bestXp).xp > 0 && bestXp !== bestProfit) {
        recs.push({
          id: 'best-xp',
          kind: 'farm',
          title: `Mais XP medida: ${bestXp.place}`,
          detail: `${fmt(perHour(bestXp).xp)} XP/h em ${hours(bestXp.activeMs)} medidos.`,
          score: perHour(bestXp).xp,
          unit: 'XP/h',
        });
      }

      // Farm pelo catálogo: caças do nível com melhor loot por abate. A velocidade de abate muda de
      // caça para caça, então isto é ponto de partida; o analyzer confirma depois.
      const estimates = catalogHunts(data, level).filter((e) => e.hunt.level >= (level ?? 0) * 0.4);
      const run = ctx?.run;
      const killsPerHour = run && run.activeMs >= 5 * 60_000 ? run.kills / (run.activeMs / HOUR) : undefined;
      const topLoot = [...estimates].sort((a, b) => b.loot - a.loot).slice(0, 3);
      for (const e of topLoot) {
        if (e.loot <= 0) continue;
        const rate = killsPerHour ? ` · no seu ritmo (${fmt(killsPerHour)} abates/h) ≈ ${fmt(e.loot * killsPerHour)} gold/h` : '';
        recs.push({
          id: `cat-loot-${e.hunt.slug}`,
          kind: 'farm',
          title: `Loot: ${e.hunt.name}${e.bonus ? ` (tipo do dia +20%)` : ''}`,
          detail: `≈ ${fmt(e.loot)} gold por abate em loot, ${fmt(e.xp)} XP base · caça nível ${e.hunt.level}${rate}.`,
          score: e.loot,
          unit: 'gold/abate',
        });
      }
      if (data.typeOfDay && data.typeOfDay.until > now) {
        const typed = estimates.filter((e) => e.bonus).sort((a, b) => b.xp - a.xp)[0];
        if (typed) {
          recs.push({
            id: 'type-of-day',
            kind: 'farm',
            title: `Tipo do dia (${data.typeOfDay.label}): ${typed.hunt.name}`,
            detail: `+20% de XP e loot até ${new Date(data.typeOfDay.until).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. Maior XP base do tipo no seu nível: ${fmt(typed.xp)} por abate.`,
            score: typed.xp,
            unit: 'XP/abate',
          });
        }
      }

      // Venda: loot parado no inventário que mais vale no NPC.
      if (acc && acc.inventory.size > 0) {
        const sell = [...acc.inventory]
          .map(([id, qty]) => ({ item: data.item(id), qty }))
          .filter((x) => x.item && x.item.category === 'loot' && x.item.npcPrice > 0)
          .map((x) => ({ name: x.item!.name, qty: x.qty, value: x.qty * x.item!.npcPrice }))
          .sort((a, b) => b.value - a.value);
        const total = sell.reduce((s, x) => s + x.value, 0);
        if (total > 0) {
          recs.push({
            id: 'sell-loot',
            kind: 'venda',
            title: `Loot no inventário vale ${fmt(total)} gold no NPC`,
            detail: sell
              .slice(0, 4)
              .map((x) => `${x.name} ×${fmt(x.qty)} = ${fmt(x.value)}`)
              .join(' · '),
            score: total,
            unit: 'gold',
          });
        }
      }

      // Compra: pokébolas e poções que acabam logo no ritmo da caçada atual.
      if (acc && run && run.activeMs >= 5 * 60_000) {
        const h = run.activeMs / HOUR;
        for (const stock of [...acc.balls, ...acc.potions]) {
          const used = run.spent[stock.name]?.qty ?? 0;
          if (used <= 0) continue;
          const perH = used / h;
          const left = stock.quantity / perH;
          if (left >= LOW_STOCK_HOURS) continue;
          const price = data.ballPrice(stock.name) || data.potionPrice(stock.name);
          const need = Math.ceil(perH * 6);
          recs.push({
            id: `buy-${stock.name}`,
            kind: 'compra',
            title: `Comprar ${stock.name}: dura ${hours(left * HOUR)}`,
            detail: `Restam ${fmt(stock.quantity)}; você usa ${fmt(perH)}/h.${price ? ` Para 6 horas: ${fmt(need)} un ≈ ${fmt(need * price)} gold.` : ''}`,
            score: LOW_STOCK_HOURS - left,
            unit: 'h',
          });
        }
      }

      return recs;
    },
  };
}
