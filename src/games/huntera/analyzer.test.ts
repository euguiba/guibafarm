import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GameState, PriceBook } from '../../sdk/types';
import { huntSessions, huntStats, hunteraAnalyzer, summarizeHunts } from './analyzer';
import { huntera } from './index';

const MIN = 60_000;
const noPrices: PriceBook = { currencyBrlPer1k: {}, itemBrl: {} };

function state(minute: number, location: string, experience: number, gold: number): GameState {
  return {
    gameId: 'huntera',
    profileId: 'p1',
    at: minute * MIN,
    character: { experience },
    resources: { gold },
    location,
  };
}

// 30 min em Rotworms (+3.000 ouro, +60.000 XP), depois 30 min em Cyclops (+9.000 ouro, +30.000 XP).
const history: GameState[] = [
  state(0, 'Rotworms', 0, 1000),
  state(30, 'Rotworms', 60_000, 4000),
  state(31, 'Cyclops', 60_000, 4000),
  state(61, 'Cyclops', 90_000, 13_000),
];

test('mede ouro e XP por hora em cada caça', () => {
  const stats = huntStats(history, noPrices);
  const rot = stats.find((s) => s.location === 'Rotworms')!;
  const cyc = stats.find((s) => s.location === 'Cyclops')!;
  assert.equal(rot.goldPerHour, 6000);
  assert.equal(rot.xpPerHour, 120_000);
  assert.equal(cyc.goldPerHour, 18_000);
  assert.equal(cyc.xpPerHour, 60_000);
});

test('ignora trechos curtos demais para medir', () => {
  const stats = huntStats([state(0, 'Dragons', 0, 0), state(2, 'Dragons', 5000, 5000)], noPrices);
  assert.equal(stats.length, 0);
});

test('recomenda a caça de maior lucro e a de maior XP', () => {
  const recs = hunteraAnalyzer.analyze(history, noPrices, 61 * MIN);
  assert.equal(recs.find((r) => r.id === 'best-profit')?.title, 'Melhor caça para lucro: Cyclops');
  assert.equal(recs.find((r) => r.id === 'best-xp')?.title, 'Melhor caça para XP: Rotworms');
  assert.equal(recs.some((r) => r.id === 'switch-hunt'), false, 'já está na melhor caça');
});

test('converte para reais quando há preço do ouro', () => {
  const prices: PriceBook = { currencyBrlPer1k: { gold: 0.5 }, itemBrl: {} };
  const best = hunteraAnalyzer.analyze(history, prices, 61 * MIN).find((r) => r.id === 'best-profit')!;
  assert.equal(best.unit, 'R$/h');
  assert.equal(best.score, 9); // 18.000 ouro/h * R$0,50 por mil
});

test('sugere trocar quando a caça atual rende muito menos', () => {
  const back = [...history, state(62, 'Rotworms', 90_000, 13_000), state(70, 'Rotworms', 100_000, 13_500)];
  const recs = hunteraAnalyzer.analyze(back, noPrices, 70 * MIN);
  const sw = recs.find((r) => r.id === 'switch-hunt');
  assert.ok(sw, 'deveria sugerir troca');
  assert.deepEqual(sw.action, { kind: 'change-hunt', params: { location: 'Cyclops' } });
});

test('alerta quando a XP para de subir', () => {
  const stuck = [state(0, 'Cyclops', 1000, 0), state(5, 'Cyclops', 2000, 100), state(20, 'Cyclops', 2000, 100)];
  const recs = hunteraAnalyzer.analyze(stuck, noPrices, 20 * MIN);
  assert.equal(recs.at(0)?.id, 'idle-alert');
});

test('separa sessões quando o app ficou fechado e não conta o tempo parado', () => {
  // 10 min caçando, 2h sem leitura, mais 10 min no mesmo local.
  const h = [state(0, 'Cyclops', 0, 0), state(10, 'Cyclops', 10_000, 1000), state(130, 'Cyclops', 10_000, 1000), state(140, 'Cyclops', 20_000, 2000)];
  const sessions = huntSessions(h, noPrices);
  assert.equal(sessions.length, 2);
  const [cyc] = huntStats(h, noPrices);
  assert.equal(cyc.durationMs, 20 * MIN);
  assert.equal(cyc.goldPerHour, 6000);
  assert.equal(cyc.sessions, 2);
});

test('compara caçadas de várias contas com faixa de nível', () => {
  const other = (minute: number, location: string, level: number, experience: number, gold: number): GameState => ({
    ...state(minute, location, experience, gold),
    profileId: 'p2',
    character: { experience, level },
  });
  const p1 = history.map((s) => ({ ...s, character: { ...s.character, level: 30 } }));
  const p2 = [other(0, 'Cyclops', 40, 0, 0), other(60, 'Cyclops', 41, 60_000, 30_000)];
  const prices: PriceBook = { currencyBrlPer1k: { gold: 0.5 }, itemBrl: {} };
  const sessions = [...huntSessions(p1, prices), ...huntSessions(p2, prices)];
  const cyc = summarizeHunts(sessions, prices).find((s) => s.location === 'Cyclops')!;
  assert.deepEqual(cyc.profileIds, ['p1', 'p2']);
  assert.equal(cyc.minLevel, 30);
  assert.equal(cyc.maxLevel, 40);
  assert.equal(cyc.durationMs, 90 * MIN);
  assert.equal(cyc.goldPerHour, 26_000); // (9.000 + 30.000) em 1,5h
  assert.equal(cyc.brlPerHour, 13);
});

test('leitor genérico extrai estado de JSON e de frames Socket.IO', () => {
  const s1 = huntera.reader.onEvent(
    { kind: 'http', url: 'https://huntera.com.br/api/me', at: 1, body: JSON.stringify({ player: { name: 'Gui', level: 42, experience: 1234, gold: '5000' } }) },
    undefined,
    'p1',
  );
  assert.equal(s1?.character.level, 42);
  assert.equal(s1?.resources.gold, 5000);
  const s2 = huntera.reader.onEvent(
    { kind: 'ws-in', url: 'wss://huntera.com.br/socket', at: 2, body: '42["update",{"exp":1300,"huntName":"Cyclops"}]' },
    s1,
    'p1',
  );
  assert.equal(s2?.character.experience, 1300);
  assert.equal(s2?.character.level, 42);
  assert.equal(s2?.location, 'Cyclops');
  const s3 = huntera.reader.onEvent({ kind: 'ws-in', url: 'wss://x', at: 3, body: '2' }, s2, 'p1');
  assert.equal(s3, undefined);
});
