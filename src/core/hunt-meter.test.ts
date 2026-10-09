import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HuntMeter, IDLE_GAP_MS } from './hunt-meter';
import type { HuntRun } from '../sdk/types';

const MIN = 60_000;

test('começa ao entrar na caça e soma XP, loot e gasto', () => {
  const m = new HuntMeter('p1');
  assert.equal(m.view(0).status, 'fora');
  m.push({ kind: 'enter', at: 0, place: 'Scyther' });
  m.push({ kind: 'kill', at: 30_000, xp: 100 });
  m.push({ kind: 'loot', at: 30_000, name: 'Straw', qty: 2, value: 2 });
  m.push({ kind: 'spend', at: 60_000, name: 'Ultra Ball', qty: 1, value: 130 });
  const v = m.view(60_000);
  assert.equal(v.status, 'caçando');
  assert.equal(v.run!.place, 'Scyther');
  assert.equal(v.run!.xp, 100);
  assert.equal(v.run!.lootValue, 2);
  assert.equal(v.run!.waste, 130);
  assert.equal(v.run!.activeMs, 60_000);
  assert.equal(v.perHour!.xp, 6000);
});

test('parada longa e pausa não contam tempo', () => {
  const m = new HuntMeter('p1');
  m.push({ kind: 'kill', at: 0, xp: 1 });
  m.push({ kind: 'kill', at: 30 * MIN, xp: 1 }); // 30 min sem nada: só conta o limite
  assert.equal(m.view(30 * MIN).run!.activeMs, IDLE_GAP_MS);
  m.setPaused(true, 30 * MIN);
  assert.equal(m.push({ kind: 'kill', at: 31 * MIN, xp: 50 }), false);
  m.setPaused(false, 40 * MIN);
  m.push({ kind: 'kill', at: 40 * MIN + 10_000, xp: 1 });
  const run = m.view(40 * MIN + 10_000).run!;
  assert.equal(run.xp, 3);
  assert.equal(run.activeMs, IDLE_GAP_MS + 10_000);
});

test('trocar de caça ou resetar guarda a anterior quando passa de 5 minutos', () => {
  const done: HuntRun[] = [];
  const m = new HuntMeter('p1', (r) => done.push(r));
  m.push({ kind: 'enter', at: 0, place: 'A' });
  for (let t = 0; t <= 6 * MIN; t += MIN) m.push({ kind: 'kill', at: t, xp: 10 });
  m.push({ kind: 'enter', at: 7 * MIN, place: 'A' }); // mesma caça: continua
  assert.equal(done.length, 0);
  m.push({ kind: 'enter', at: 7 * MIN, place: 'B' });
  assert.equal(done.length, 1);
  assert.equal(done[0].place, 'A');
  m.push({ kind: 'kill', at: 8 * MIN, xp: 10 });
  m.reset(8 * MIN);
  assert.equal(done.length, 1, 'caçada curta não vai para o histórico');
  assert.equal(m.view(8 * MIN).run!.place, 'B');
  assert.equal(m.view(8 * MIN).run!.xp, 0);
});
