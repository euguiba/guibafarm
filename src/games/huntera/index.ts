// Módulo do Huntera (piloto).
//
// O protocolo do jogo ainda não está mapeado. Até o teste de rede, o leitor usa
// o extrator genérico com os nomes de campo mais prováveis (estilo Tibia).
// Grave uma sessão com "Gravar tráfego" e ajuste HUNTERA_FIELDS com o que aparecer.

import { readEvent, type FieldAliases } from '../../sdk/json-fields';
import type { GameModule } from '../../sdk/types';
import { hunteraAnalyzer, hunteraHunts } from './analyzer';
import { hunteraPageReader } from './page';

export const HUNTERA_FIELDS: FieldAliases = {
  name: ['characterName', 'charName', 'name'],
  level: ['level', 'lvl'],
  experience: ['experience', 'exp', 'xp'],
  vocation: ['vocation', 'class'],
  location: ['huntName', 'hunt', 'area', 'map', 'location'],
  resources: {
    gold: ['gold', 'money', 'balance'],
    huntera_coins: ['hunteraCoins', 'coins', 'premiumCoins'],
    hp: ['health', 'hp'],
    mana: ['mana', 'mp'],
  },
};

export const huntera: GameModule = {
  manifest: {
    id: 'huntera',
    name: 'Huntera',
    startUrl: 'https://huntera.com.br/welcome',
    hosts: ['huntera.com.br'],
    // Regras: ferramentas de apoio podem abrir até 4 contas.
    maxAccounts: 4,
    roles: [
      { id: 'knight', name: 'Knight', short: 'EK', color: '#f87171' },
      { id: 'paladin', name: 'Paladino', short: 'RP', color: '#fbbf24' },
      { id: 'druid', name: 'Druida', short: 'ED', color: '#34d399' },
      { id: 'sorcerer', name: 'Sorcerer', short: 'MS', color: '#a78bfa' },
    ],
    policy: {
      read: true,
      recommend: true,
      // Regras: proibido o que jogue no seu lugar; permitidos medidores, multicontas
      // até 4 e recursos de organização ou visualização.
      automate: false,
      note: 'O Huntera não aceita automação. O navegador só lê o jogo e recomenda; quem joga é você.',
    },
  },
  reader: {
    onEvent(event, previous, profileId) {
      return readEvent(event, previous, HUNTERA_FIELDS, { gameId: 'huntera', profileId });
    },
  },
  pageReader: hunteraPageReader,
  analyzer: hunteraAnalyzer,
  hunts: hunteraHunts,
};
