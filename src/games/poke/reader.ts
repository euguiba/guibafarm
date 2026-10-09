// Leitor do Poke Idle World: traduz o tráfego da aba (WebSocket do jogo e catálogos HTTP) em
// estado da conta e em fatos de caça. O chat do jogo é ignorado de propósito: ele traz nível e
// nome de outros jogadores e, lido como estado, gerava alertas falsos.

import type { CapturedEvent, GameState, HuntEvent, StateReader } from '../../sdk/types';
import { TYPE_NAMES, type PokeData, type Stock } from './data';

/** Estado com XP nova vai para o histórico no máximo uma vez por este intervalo. */
const STATE_EVERY_MS = 60_000;

/** Mensagens que interessam; o resto (campo, chat, mapa) nem é decodificado. */
const WANTED = new Set([
  'field-kill',
  'inventory',
  'balls',
  'autohelper',
  'catch-result',
  'auto-heal',
  'autocatch-refused',
  'events',
  'enter-hunt',
  'field-init',
]);

function typeOf(body: string): string | undefined {
  return /^\{"type":"([\w-]+)"/.exec(body)?.[1];
}

function parse(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function stocks(list: any[] | undefined): Stock[] {
  return (list ?? []).map((b) => ({ id: Number(b.id), name: String(b.name), quantity: Number(b.quantity) || 0 }));
}

function path(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

/** Respostas HTTP que o leitor usa; o resto nem tem o corpo copiado. */
export const POKE_HTTP = /\/game\/(items|creatures)\.json|\/api\/game\/(profile|map-markers|auto-helper)(\?|$)/;

export function pokeReader(data: PokeData): StateReader {
  const base = (prev: GameState | undefined, profileId: string, at: number): GameState => ({
    gameId: 'poke-idle-world',
    profileId,
    at,
    character: { ...prev?.character },
    resources: { ...prev?.resources },
    location: prev?.location,
  });

  return {
    onEvent(event: CapturedEvent, prev, profileId) {
      const acc = data.account(profileId);
      if (event.kind === 'http') {
        const p = path(event.url);
        const json = parse(event.body);
        if (!json) return undefined;
        if (p.endsWith('/game/items.json')) data.loadItems(json);
        else if (p.endsWith('/game/creatures.json')) data.loadCreatures(json);
        else if (p.endsWith('/api/game/map-markers')) data.loadHunts(json);
        else if (p.endsWith('/api/game/auto-helper')) {
          acc.balls = stocks(json.balls);
          acc.potions = stocks(json.potions);
          acc.autoCatchBallId = Number(json.autoCatchBallId) || undefined;
        } else if (p.endsWith('/api/game/profile')) {
          Object.assign(acc, { name: json.name, level: json.level, xp: json.xp, gold: json.gold, diamonds: json.diamonds });
          const next = base(prev, profileId, event.at);
          next.character = { ...next.character, name: String(json.name ?? ''), level: Number(json.level), experience: Number(json.xp) };
          next.resources = { ...next.resources, gold: Number(json.gold) || 0, diamonds: Number(json.diamonds) || 0 };
          return next;
        }
        return undefined;
      }

      const type = typeOf(event.body);
      if (!type || !WANTED.has(type)) return undefined;
      const msg = parse(event.body);
      if (!msg) return undefined;

      if (event.kind === 'ws-out') {
        if (type !== 'enter-hunt' || !msg.slug) return undefined;
        acc.place = data.placeName(String(msg.slug));
        const next = base(prev, profileId, event.at);
        next.location = acc.place;
        return next;
      }

      switch (type) {
        case 'field-init':
          if (msg.slug) acc.place = data.placeName(String(msg.slug));
          return undefined;
        case 'inventory':
          acc.inventory = new Map((msg.items ?? []).map((i: any) => [Number(i.itemId), Number(i.quantity) || 0]));
          return undefined;
        case 'balls':
          data.loadBalls(msg.catalog);
          return undefined;
        case 'autohelper':
          acc.balls = stocks(msg.balls);
          acc.potions = stocks(msg.potions);
          acc.autoCatchBallId = Number(msg.autoCatchBallId) || undefined;
          if (acc.outOfBall && acc.balls.some((b) => b.name === acc.outOfBall && b.quantity > 0)) acc.outOfBall = undefined;
          return undefined;
        case 'autocatch-refused':
          if (msg.reason === 'no-ball') acc.outOfBall = data.balls.get(Number(msg.ballId))?.name ?? 'a pokébola escolhida';
          return undefined;
        case 'events': {
          const day = (msg.events ?? []).find((e: any) => e.key === 'type-of-day');
          const label = day ? String(day.name).split(':').pop()!.trim() : '';
          const type = TYPE_NAMES[label.toLowerCase()];
          data.typeOfDay = day && type ? { type, label, until: Number(day.until) || 0 } : undefined;
          return undefined;
        }
        case 'field-kill': {
          const level = Number(msg.level);
          const xp = Number(msg.totalXp);
          if (!Number.isFinite(level) || !Number.isFinite(xp)) return undefined;
          acc.level = level;
          acc.xp = xp;
          const changed = prev?.character.level !== level || !prev || event.at - prev.at >= STATE_EVERY_MS;
          if (!changed) return undefined;
          const next = base(prev, profileId, event.at);
          next.character = { ...next.character, level, experience: xp };
          if (acc.place) next.location = acc.place;
          return next;
        }
      }
      return undefined;
    },

    huntEvents(event: CapturedEvent): HuntEvent[] {
      if (event.kind === 'http') return [];
      const type = typeOf(event.body);
      if (!type || !WANTED.has(type)) return [];
      const msg = parse(event.body);
      if (!msg) return [];
      const at = event.at;
      if (event.kind === 'ws-out') {
        return type === 'enter-hunt' && msg.slug ? [{ kind: 'enter', at, place: data.placeName(String(msg.slug)) }] : [];
      }
      switch (type) {
        case 'field-kill': {
          const out: HuntEvent[] = [{ kind: 'kill', at, xp: Number(msg.xpGained) || 0, name: msg.speciesName, shiny: !!msg.shiny }];
          for (const l of msg.loot ?? []) {
            const qty = Number(l.qty) || 1;
            const price = data.item(Number(l.itemId))?.npcPrice ?? data.item(String(l.name))?.npcPrice ?? 0;
            out.push({ kind: 'loot', at, name: String(l.name), qty, value: price * qty });
          }
          return out;
        }
        case 'catch-result': {
          const out: HuntEvent[] = [{ kind: 'catch', at, name: msg.speciesName, success: !!msg.success, shiny: !!msg.shiny }];
          if (msg.ballName) out.push({ kind: 'spend', at, name: String(msg.ballName), qty: 1, value: data.ballPrice(String(msg.ballName)) });
          return out;
        }
        case 'auto-heal':
          return msg.name ? [{ kind: 'spend', at, name: String(msg.name), qty: 1, value: data.potionPrice(String(msg.name)) }] : [];
        case 'autocatch-refused':
          return [
            {
              kind: 'notice',
              at,
              key: 'no-ball',
              title: 'Auto-Catch pausado',
              body: String(msg.message ?? 'Acabou a pokébola escolhida no Auto-Helper.'),
            },
          ];
      }
      return [];
    },
  };
}
