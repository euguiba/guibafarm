// Módulo do Huntera (piloto).
//
// O protocolo do jogo ainda não está mapeado. Até o teste de rede, o leitor usa
// o extrator genérico com os nomes de campo mais prováveis (estilo Tibia).
// Grave uma sessão com "Gravar tráfego" e ajuste HUNTERA_FIELDS com o que aparecer.

import { readEvent, type FieldAliases } from '../../sdk/json-fields';
import type { GameModule } from '../../sdk/types';
import { hunteraAnalyzer, hunteraHunts } from './analyzer';

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
    // Relato de fórum fala em ban acima de 4 navegadores por IP; não confirmado.
    maxAccounts: 4,
    policy: {
      read: true,
      recommend: true,
      // As regras do Huntera não aceitam automação; não implementar actor.
      automate: false,
      note: 'As regras do Huntera não aceitam automação. O app só lê e recomenda.',
    },
  },
  reader: {
    onEvent(event, previous, profileId) {
      return readEvent(event, previous, HUNTERA_FIELDS, { gameId: 'huntera', profileId });
    },
  },
  analyzer: hunteraAnalyzer,
  hunts: hunteraHunts,
};
