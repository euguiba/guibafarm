import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupIcon, groupKey, groupLabel } from './groups';

test('cada jogo é um grupo e cada site avulso vira o seu', () => {
  assert.equal(groupKey({ gameId: 'huntera' }), 'huntera');
  assert.equal(groupKey({ gameId: 'site', url: 'https://www.gengar.com.br/jogo' }), 'site:gengar.com.br');
  assert.equal(groupKey({ gameId: 'site', url: 'http://127.0.0.1:8765/' }), 'site:127.0.0.1:8765');
  assert.equal(groupLabel('site:gengar.com.br', () => undefined), 'gengar.com.br');
  assert.equal(groupLabel('huntera', () => 'Huntera'), 'Huntera');
});

test('ícone escolhido vence o padrão do jogo', () => {
  assert.equal(groupIcon('huntera', {}), 'swords');
  assert.equal(groupIcon('huntera', { huntera: 'crown' }), 'crown');
  assert.equal(groupIcon('site:x.com', {}), 'gamepad-2');
  assert.equal(groupLabel('huntera', () => 'Huntera', { huntera: 'Huntera – Equipe Principal' }), 'Huntera – Equipe Principal');
});
