import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCells, toAddress, visibleIds } from './tiles';

const AREA = { x: 340, y: 100, width: 1000, height: 600 };

test('1x1 mostra só a conta selecionada', () => {
  assert.deepEqual(visibleIds('1x1', ['a', 'b', 'c'], 'b'), ['b']);
  assert.deepEqual(visibleIds('1x1', ['a', 'b'], undefined), ['a']);
});

test('grade cheia troca a última célula pela conta selecionada', () => {
  assert.deepEqual(visibleIds('split', ['a', 'b', 'c'], 'c'), ['a', 'c']);
  assert.deepEqual(visibleIds('2x2', ['a', 'b'], 'a'), ['a', 'b']);
});

test('2x2 divide a área em quatro células com espaçamento', () => {
  const cells = computeCells('2x2', ['a', 'b', 'c'], 'a', AREA, { pad: 10, gap: 10 });
  assert.equal(cells.length, 4);
  assert.deepEqual(cells[0], { x: 350, y: 110, width: 485, height: 285, profileId: 'a' });
  assert.deepEqual(cells[3], { x: 845, y: 405, width: 485, height: 285, profileId: undefined });
});

test('barra de endereço aceita site, endereço completo ou busca', () => {
  assert.equal(toAddress('huntera.com.br/game'), 'https://huntera.com.br/game');
  assert.equal(toAddress('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(toAddress('127.0.0.1:8765/?x=1'), 'http://127.0.0.1:8765/?x=1');
  assert.equal(toAddress('melhor hunt huntera'), 'https://www.google.com/search?q=melhor%20hunt%20huntera');
  assert.equal(toAddress('  '), undefined);
});
