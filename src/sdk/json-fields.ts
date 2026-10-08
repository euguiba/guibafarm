// Leitor genérico: procura campos conhecidos em qualquer JSON que passe pela rede.
// Serve enquanto o protocolo de cada jogo não está mapeado; depois do teste de rede,
// o módulo do jogo pode trocar isto por um parser exato.

import type { CapturedEvent, GameState } from './types';

export interface FieldAliases {
  name?: string[];
  level?: string[];
  experience?: string[];
  vocation?: string[];
  location?: string[];
  /** Nome do recurso no GameState -> chaves possíveis no JSON. */
  resources?: Record<string, string[]>;
}

export interface ExtractedFields {
  name?: string;
  level?: number;
  experience?: number;
  vocation?: string;
  location?: string;
  resources: Record<string, number>;
}

const MAX_DEPTH = 8;

export function parseJsonBody(body: string): unknown | undefined {
  const text = body.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) {
    // Socket.IO e similares prefixam o JSON com dígitos ("42[...]").
    const start = text.search(/[[{]/);
    if (start <= 0 || !/^\d+$/.test(text.slice(0, start))) return undefined;
    return parseJsonBody(text.slice(start));
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return undefined;
}

/** Percorre o JSON e devolve o primeiro valor de cada campo pedido. */
export function extractFields(data: unknown, aliases: FieldAliases): ExtractedFields {
  const want = new Map<string, string>(); // chave normalizada -> campo
  const add = (field: string, keys: string[] | undefined) => {
    for (const k of keys ?? []) want.set(normalizeKey(k), field);
  };
  add('name', aliases.name);
  add('level', aliases.level);
  add('experience', aliases.experience);
  add('vocation', aliases.vocation);
  add('location', aliases.location);
  for (const [resource, keys] of Object.entries(aliases.resources ?? {})) add(`resource:${resource}`, keys);

  const found: ExtractedFields = { resources: {} };
  const seen = new Set<string>();

  const visit = (node: unknown, depth: number) => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const field = want.get(normalizeKey(key));
      if (field && !seen.has(field)) {
        if (field === 'name' || field === 'vocation' || field === 'location') {
          if (typeof value === 'string' && value.length > 0) {
            found[field] = value;
            seen.add(field);
          }
        } else {
          const n = toNumber(value);
          if (n !== undefined) {
            if (field.startsWith('resource:')) found.resources[field.slice(9)] = n;
            else (found as unknown as Record<string, number>)[field] = n;
            seen.add(field);
          }
        }
      }
      if (typeof value === 'object') visit(value, depth + 1);
    }
  };
  visit(data, 0);
  return found;
}

/** Junta campos extraídos ao estado anterior. Devolve undefined se nada mudou. */
export function mergeState(
  previous: GameState | undefined,
  fields: ExtractedFields,
  base: { gameId: string; profileId: string; at: number },
): GameState | undefined {
  const next: GameState = {
    gameId: base.gameId,
    profileId: base.profileId,
    at: base.at,
    character: { ...previous?.character },
    resources: { ...previous?.resources },
    location: previous?.location,
    inventory: previous?.inventory,
  };
  let changed = false;
  for (const key of ['name', 'level', 'experience', 'vocation'] as const) {
    const value = fields[key];
    if (value !== undefined && next.character[key] !== value) {
      (next.character as Record<string, unknown>)[key] = value;
      changed = true;
    }
  }
  if (fields.location !== undefined && fields.location !== next.location) {
    next.location = fields.location;
    changed = true;
  }
  for (const [resource, value] of Object.entries(fields.resources)) {
    if (next.resources[resource] !== value) {
      next.resources[resource] = value;
      changed = true;
    }
  }
  return changed ? next : undefined;
}

export function readEvent(
  event: CapturedEvent,
  previous: GameState | undefined,
  aliases: FieldAliases,
  base: { gameId: string; profileId: string },
): GameState | undefined {
  const data = parseJsonBody(event.body);
  if (data === undefined) return undefined;
  return mergeState(previous, extractFields(data, aliases), { ...base, at: event.at });
}
