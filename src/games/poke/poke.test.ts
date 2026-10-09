import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CapturedEvent, GameState } from '../../sdk/types';
import { pokeAdvisor } from './advisor';
import { PokeData } from './data';
import { pokeReader } from './reader';

const WS = 'wss://poke.idleworld.online/ws';
const ws = (kind: 'ws-in' | 'ws-out', msg: unknown, at = 1000): CapturedEvent => ({ kind, url: WS, at, body: JSON.stringify(msg) });
const http = (path: string, json: unknown): CapturedEvent => ({ kind: 'http', url: `https://poke.idleworld.online${path}`, at: 0, body: JSON.stringify(json) });

function setup() {
  const data = new PokeData();
  const reader = pokeReader(data);
  reader.onEvent(http('/game/items.json', { items: [
    { id: 131, name: 'Straw', category: 'loot', npcPrice: 1 },
    { id: 102, name: 'Pot of Moss Bug', category: 'loot', npcPrice: 8 },
    { id: 203, name: 'Hyper Potion', category: 'heal', npcPrice: 800, priceGold: 55 },
  ] }), undefined, 'p1');
  reader.onEvent(http('/game/creatures.json', { creatures: [
    { pokeId: 123, name: 'Scyther', type1: 'BUG', type2: 'FLYING', experience: 200, huntLevel: 100,
      loot: [{ name: 'Pot of Moss Bug', chance: 50000, minCount: 1, maxCount: 3 }] },
    { pokeId: 92, name: 'Gastly', type1: 'GHOST', experience: 90, huntLevel: 30,
      loot: [{ name: 'Straw', chance: 100000, minCount: 1, maxCount: 1 }] },
  ] }), undefined, 'p1');
  reader.onEvent(http('/api/game/map-markers', { hunts: [
    { slug: 'scyther', name: 'Scyther', level: 100, area: 'kanto' },
    { slug: 'gastly', name: 'Gastly', level: 80, area: 'kanto' },
    { slug: 'mewtwo', name: 'Mewtwo', level: 900, area: 'kanto' },
  ] }), undefined, 'p1');
  reader.onEvent(ws('ws-in', { type: 'balls', catalog: [{ id: 4, name: 'Ultra Ball', priceGold: 130, buyable: true }] }), undefined, 'p1');
  return { data, reader };
}

test('chat de outros jogadores não muda nível nem nome da conta', () => {
  const { reader } = setup();
  const prev: GameState = { gameId: 'poke-idle-world', profileId: 'p1', at: 0, character: { name: 'euxopes', level: 189 }, resources: {} };
  const chat = ws('ws-in', { type: 'chat', msg: { fromName: 'Outro', level: 505, body: 'oi' } });
  assert.equal(reader.onEvent(chat, prev, 'p1'), undefined);
  assert.deepEqual(reader.huntEvents!(chat, 'p1'), []);
});

test('abate, loot, captura e poção viram fatos de caça com valor', () => {
  const { reader } = setup();
  const enter = reader.huntEvents!(ws('ws-out', { type: 'enter-hunt', slug: 'scyther', resume: false }), 'p1');
  assert.deepEqual(enter, [{ kind: 'enter', at: 1000, place: 'Scyther' }]);
  const kill = reader.huntEvents!(ws('ws-in', { type: 'field-kill', xpGained: 6082, totalXp: 5, level: 189, speciesName: 'Scyther', shiny: false,
    loot: [{ itemId: 131, name: 'Straw', qty: 2 }, { itemId: 102, name: 'Pot of Moss Bug', qty: 1 }] }), 'p1');
  assert.deepEqual(kill.map((e) => e.kind), ['kill', 'loot', 'loot']);
  assert.equal(kill.reduce((s, e) => s + (e.kind === 'loot' ? e.value : 0), 0), 2 + 8);
  const ball = reader.huntEvents!(ws('ws-in', { type: 'catch-result', success: false, speciesName: 'Scyther', ballName: 'Ultra Ball', ballId: 4 }), 'p1');
  assert.deepEqual(ball[1], { kind: 'spend', at: 1000, name: 'Ultra Ball', qty: 1, value: 130 });
  const heal = reader.huntEvents!(ws('ws-in', { type: 'auto-heal', kind: 'potion', name: 'Hyper Potion', heal: 1000 }), 'p1');
  assert.deepEqual(heal, [{ kind: 'spend', at: 1000, name: 'Hyper Potion', qty: 1, value: 55 }]);
});

test('recomenda caça do nível, venda do loot e aviso de pokébola', () => {
  const { data, reader } = setup();
  reader.onEvent(ws('ws-in', { type: 'field-kill', xpGained: 1, totalXp: 5, level: 189, loot: [] }), undefined, 'p1');
  reader.onEvent(ws('ws-in', { type: 'inventory', items: [{ itemId: 102, quantity: 743 }, { itemId: 131, quantity: 10 }] }), undefined, 'p1');
  reader.onEvent(ws('ws-in', { type: 'events', events: [{ key: 'type-of-day', name: '👻 Tipo do Dia: Fantasma', until: 10_000 }] }), undefined, 'p1');
  reader.onEvent(ws('ws-in', { type: 'autocatch-refused', reason: 'no-ball', ballId: 4 }), undefined, 'p1');
  assert.equal(data.typeOfDay?.type, 'GHOST');
  const state: GameState = { gameId: 'poke-idle-world', profileId: 'p1', at: 0, character: { level: 189 }, resources: {} };
  const recs = pokeAdvisor(data).analyze([], { currencyBrlPer1k: {}, itemBrl: {} }, 0, { runs: [], state });
  const ids = recs.map((r) => r.id);
  assert.ok(ids.includes('no-ball'));
  assert.ok(ids.includes('cat-loot-scyther'));
  assert.ok(!ids.includes('cat-loot-mewtwo'), 'caça acima do nível fica de fora');
  assert.ok(ids.includes('type-of-day'));
  const sell = recs.find((r) => r.id === 'sell-loot')!;
  assert.equal(sell.score, 743 * 8 + 10);
});
