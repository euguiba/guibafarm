// Módulo do Poke Idle World: lê o WebSocket do jogo (abates, loot, capturas, poções) e os
// catálogos que a página carrega, mede cada caçada e recomenda farm, venda e compra.

import type { GameModule } from '../../sdk/types';
import { pokeAdvisor } from './advisor';
import { PokeData } from './data';
import { POKE_HTTP, pokeReader } from './reader';

/** Catálogos e contas do Poke, compartilhados entre as contas abertas. */
export const pokeData = new PokeData();

export const pokeIdleWorld: GameModule = {
  manifest: {
    id: 'poke-idle-world',
    name: 'Poke Idle World',
    startUrl: 'https://poke.idleworld.online/login',
    hosts: ['poke.idleworld.online'],
    maxAccounts: 4,
    policy: {
      read: true,
      recommend: true,
      automate: false,
      note: 'As regras proíbem programas, scripts e extensões sem permissão da staff, e macros. O app só lê e recomenda; limite de 4 contas.',
    },
  },
  network: { http: POKE_HTTP, ws: true },
  reader: pokeReader(pokeData),
  analyzer: pokeAdvisor(pokeData),
};
