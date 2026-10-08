// Registro dos módulos de jogo. Huntera é o piloto; os outros três abrem com
// perfis isolados e leitor genérico, sem analisador nem automação por enquanto.

import { readEvent, type FieldAliases } from '../sdk/json-fields';
import type { GameManifest, GameModule } from '../sdk/types';
import { huntera } from './huntera';

const GENERIC_FIELDS: FieldAliases = {
  name: ['name', 'username'],
  level: ['level', 'lvl'],
  experience: ['experience', 'exp', 'xp'],
  location: ['map', 'area', 'location'],
  resources: { gold: ['gold'], diamonds: ['diamonds', 'diamond'] },
};

function readOnlyModule(manifest: GameManifest): GameModule {
  return {
    manifest,
    reader: {
      onEvent(event, previous, profileId) {
        return readEvent(event, previous, GENERIC_FIELDS, { gameId: manifest.id, profileId });
      },
    },
  };
}

const pokeIdleWorld = readOnlyModule({
  id: 'poke-idle-world',
  name: 'Poke Idle World',
  startUrl: 'https://poke.idleworld.online/login',
  hosts: ['poke.idleworld.online'],
  maxAccounts: 4,
  policy: {
    read: true,
    recommend: true,
    automate: false,
    note: 'As regras proíbem programas, scripts e extensões sem permissão da staff, e macros. Limite de 4 contas.',
  },
});

const levelingIdle = readOnlyModule({
  id: 'leveling-idle',
  name: 'Leveling Idle',
  startUrl: 'https://levelingidle2d.com.br/jogar',
  hosts: ['levelingidle2d.com.br'],
  policy: {
    read: true,
    recommend: true,
    automate: false,
    note: 'Sem regras públicas encontradas; automação desligada até confirmar com a staff.',
  },
});

const rollerCoin = readOnlyModule({
  id: 'rollercoin',
  name: 'RollerCoin',
  startUrl: 'https://rollercoin.com/',
  hosts: ['rollercoin.com'],
  policy: {
    read: true,
    recommend: true,
    automate: false,
    note: 'Termos 1.10 e 2.2 proíbem bots, scripts e macros; venda de contas proibida (2.1).',
  },
});

// Qualquer outro site digitado pela pessoa: só a sessão isolada, nada é lido.
const otherSite: GameModule = {
  manifest: {
    id: 'site',
    name: 'Outro site',
    startUrl: 'about:blank',
    hosts: [],
    policy: { read: false, recommend: false, automate: false, note: 'Site avulso: só a sessão isolada, sem leitura nem análise.' },
  },
  reader: { onEvent: () => undefined },
};

export const GAMES: GameModule[] = [huntera, pokeIdleWorld, levelingIdle, rollerCoin, otherSite];

export function findGame(id: string): GameModule | undefined {
  return GAMES.find((g) => g.manifest.id === id);
}
