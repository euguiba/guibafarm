// Dados do Poke Idle World que o próprio jogo carrega: catálogos (itens, criaturas, mapa de
// caças, pokébolas) e, por conta, perfil, inventário e estoque do auto-helper.
// Tudo vem do tráfego da aba; o app não faz pedidos próprios ao servidor do jogo.

export interface ItemInfo {
  id: number;
  name: string;
  category: string;
  /** Quanto o NPC paga pelo item. */
  npcPrice: number;
  /** Preço de compra na loja, quando o item é vendido lá (poções). */
  priceGold?: number;
}

export interface LootEntry {
  name: string;
  /** Chance em 1/100.000, como no catálogo do jogo. */
  chance: number;
  min: number;
  max: number;
}

export interface CreatureInfo {
  id: number;
  name: string;
  types: string[];
  experience: number;
  huntLevel: number;
  loot: LootEntry[];
}

export interface HuntInfo {
  slug: string;
  name: string;
  level: number;
  area: string;
}

export interface BallInfo {
  id: number;
  name: string;
  priceGold: number;
  buyable: boolean;
}

export interface Stock {
  id: number;
  name: string;
  quantity: number;
}

export interface PokeAccount {
  name?: string;
  level?: number;
  xp?: number;
  gold?: number;
  diamonds?: number;
  place?: string;
  inventory: Map<number, number>;
  balls: Stock[];
  potions: Stock[];
  autoCatchBallId?: number;
  /** Pokébola que acabou e pausou o auto-catch, até o estoque voltar. */
  outOfBall?: string;
}

export class PokeData {
  readonly items = new Map<number, ItemInfo>();
  readonly itemsByName = new Map<string, ItemInfo>();
  readonly creatures = new Map<number, CreatureInfo>();
  readonly creaturesByName = new Map<string, CreatureInfo>();
  readonly hunts = new Map<string, HuntInfo>();
  readonly balls = new Map<number, BallInfo>();
  /** Tipo com bônus hoje (ex.: GHOST) e até quando. */
  typeOfDay?: { type: string; label: string; until: number };
  private readonly accounts = new Map<string, PokeAccount>();

  account(profileId: string): PokeAccount {
    let a = this.accounts.get(profileId);
    if (!a) {
      a = { inventory: new Map(), balls: [], potions: [] };
      this.accounts.set(profileId, a);
    }
    return a;
  }

  item(idOrName: number | string): ItemInfo | undefined {
    return typeof idOrName === 'number' ? this.items.get(idOrName) : this.itemsByName.get(idOrName.toLowerCase());
  }

  ballPrice(name: string): number {
    for (const b of this.balls.values()) if (b.name === name) return b.priceGold;
    return 0;
  }

  /** Custo de uma poção: preço da loja, ou o do NPC quando a loja não informa. */
  potionPrice(name: string): number {
    const it = this.item(name);
    return it?.priceGold ?? it?.npcPrice ?? 0;
  }

  loadItems(json: any): void {
    for (const raw of json?.items ?? []) {
      const it: ItemInfo = {
        id: Number(raw.id),
        name: String(raw.name),
        category: String(raw.category ?? ''),
        npcPrice: Number(raw.npcPrice) || 0,
        priceGold: Number(raw.priceGold) > 0 ? Number(raw.priceGold) : undefined,
      };
      this.items.set(it.id, it);
      this.itemsByName.set(it.name.toLowerCase(), it);
    }
  }

  loadCreatures(json: any): void {
    for (const raw of json?.creatures ?? []) {
      const c: CreatureInfo = {
        id: Number(raw.pokeId),
        name: String(raw.name),
        types: [raw.type1, raw.type2].filter(Boolean).map(String),
        experience: Number(raw.experience) || 0,
        huntLevel: Number(raw.huntLevel) || 0,
        loot: (raw.loot ?? []).map((l: any) => ({
          name: String(l.name),
          chance: Number(l.chance) || 0,
          min: Number(l.minCount) || 1,
          max: Number(l.maxCount) || Number(l.minCount) || 1,
        })),
      };
      this.creatures.set(c.id, c);
      this.creaturesByName.set(c.name.toLowerCase(), c);
    }
  }

  loadHunts(json: any): void {
    for (const raw of json?.hunts ?? []) {
      this.hunts.set(String(raw.slug), { slug: String(raw.slug), name: String(raw.name), level: Number(raw.level) || 0, area: String(raw.area ?? '') });
    }
  }

  loadBalls(catalog: any[]): void {
    for (const raw of catalog ?? []) {
      this.balls.set(Number(raw.id), { id: Number(raw.id), name: String(raw.name), priceGold: Number(raw.priceGold) || 0, buyable: !!raw.buyable });
    }
  }

  /** Valor médio do loot de um abate, em ouro do NPC. */
  lootPerKill(c: CreatureInfo): number {
    let sum = 0;
    for (const l of c.loot) {
      const price = this.item(l.name)?.npcPrice ?? 0;
      sum += (l.chance / 100_000) * ((l.min + l.max) / 2) * price;
    }
    return sum;
  }

  /** A criatura de uma caça: a de mesmo nome (a maioria das caças leva o nome do Pokémon). */
  creatureOfHunt(h: HuntInfo): CreatureInfo | undefined {
    return this.creaturesByName.get(h.name.toLowerCase());
  }

  placeName(slug: string): string {
    return this.hunts.get(slug)?.name ?? slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

/** Nome em português do tipo do dia -> tipo do catálogo. */
export const TYPE_NAMES: Record<string, string> = {
  normal: 'NORMAL',
  fogo: 'FIRE',
  água: 'WATER',
  agua: 'WATER',
  planta: 'GRASS',
  grama: 'GRASS',
  elétrico: 'ELECTRIC',
  eletrico: 'ELECTRIC',
  gelo: 'ICE',
  lutador: 'FIGHTING',
  luta: 'FIGHTING',
  veneno: 'POISON',
  terra: 'GROUND',
  voador: 'FLYING',
  psíquico: 'PSYCHIC',
  psiquico: 'PSYCHIC',
  inseto: 'BUG',
  pedra: 'ROCK',
  rocha: 'ROCK',
  fantasma: 'GHOST',
  dragão: 'DRAGON',
  dragao: 'DRAGON',
  sombrio: 'DARK',
  noturno: 'DARK',
  aço: 'STEEL',
  aco: 'STEEL',
  metal: 'STEEL',
  fada: 'FAIRY',
};
