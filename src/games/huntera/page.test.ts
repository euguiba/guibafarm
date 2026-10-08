import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAlerts } from '../../core/alerts';
import { hunteraAnalyzer } from './analyzer';
import { hunteraPageReader, parseGameNumber, parseLog, parsePanel } from './page';

const PANEL = `Gui\nLv. 87\nExperiência\n42,5%\nCapacidade\n1.234 oz\nStamina\n38:20 h`;

test('lê nível, capacidade, stamina e XP do painel', () => {
  const p = parsePanel(PANEL);
  assert.equal(p.level, 87);
  assert.equal(p.capacityOz, 1234);
  assert.equal(p.staminaMin, 38 * 60 + 20);
  assert.equal(p.xpPercent, 42.5);
  assert.equal(p.disconnected, false);
  assert.equal(parsePanel('Você foi desconectado do servidor').disconnected, true);
});

test('números com separador de milhar e decimal', () => {
  assert.equal(parseGameNumber('12.345'), 12345);
  assert.equal(parseGameNumber('12,345'), 12345);
  assert.equal(parseGameNumber('12,5'), 12.5);
});

test('soma XP, dano e maior hit do log em português e inglês', () => {
  const t = parseLog([
    'Você ganhou 1.250 de experiência.',
    'You gained 73 experience points.',
    'Você acertou Cyclops causando 1.234.',
    'Crítico! Você acertou Cyclops causando 2.500.',
    'Critical! You hit Dragon for 99.',
    'Cyclops ataca você.',
  ]);
  assert.deepEqual(t, { xp: 1323, damage: 3833, hits: 3, biggestHit: 2500, deaths: 0 });
});

test('estado acumula o log entre leituras e não repete quando nada muda', () => {
  const s1 = hunteraPageReader.onSnapshot({ at: 1, text: PANEL, logLines: ['Você ganhou 100 de experiência.'] }, undefined, 'p1')!;
  assert.equal(s1.resources.xp_log, 100);
  const s2 = hunteraPageReader.onSnapshot({ at: 2, text: PANEL, logLines: ['Você ganhou 50 de experiência.'] }, s1, 'p1')!;
  assert.equal(s2.resources.xp_log, 150);
  assert.equal(hunteraPageReader.onSnapshot({ at: 3, text: PANEL, logLines: [] }, s2, 'p1'), undefined);
});

test('analisador usa a XP do log quando a rede não informa XP', () => {
  const MIN = 60_000;
  const mk = (min: number, xp: number) => ({ gameId: 'huntera', profileId: 'p1', at: min * MIN, character: {}, resources: { xp_log: xp }, location: 'Cyclops' });
  const recs = hunteraAnalyzer.analyze([mk(0, 0), mk(30, 50_000)], { currencyBrlPer1k: {}, itemBrl: {} }, 30 * MIN);
  assert.equal(recs.find((r) => r.id === 'best-xp')?.score, 100_000);
});

test('alertas de nível, stamina, desconexão e morte', () => {
  const base = { gameId: 'huntera', profileId: 'p1', at: 1, location: undefined };
  const prev = { ...base, character: { level: 10 }, resources: { stamina_min: 61, disconnected: 0, deaths: 0 } };
  const next = { ...base, at: 2, character: { level: 11 }, resources: { stamina_min: 60, disconnected: 1, deaths: 1 } };
  const kinds = detectAlerts(prev, next, 'Gui').map((a) => a.kind);
  assert.deepEqual(kinds, ['level', 'stamina', 'disconnected', 'death']);
  assert.deepEqual(detectAlerts(next, next, 'Gui'), []);
});
