// Páginas de contas: cada jogo é um grupo, e cada site avulso ("Outro site") vira
// um grupo próprio pelo endereço, para as contas de jogos diferentes não se misturarem.

import type { Profile } from './store';

const DEFAULT_ICONS: Record<string, string> = {
  huntera: 'swords',
  'poke-idle-world': 'paw-print',
  'leveling-idle': 'sword',
  rollercoin: 'coins',
};

/** Ícones que a pessoa pode escolher para páginas e contas; os desenhos ficam em src/ui/icons.ts. */
export const ICON_IDS = [
  'swords', 'sword', 'shield', 'axe', 'hammer', 'wand-sparkles', 'flask-conical', 'skull', 'crown',
  'gem', 'coins', 'trophy', 'gamepad-2', 'dices', 'ghost', 'paw-print', 'flame', 'zap', 'heart',
  'star', 'sparkles', 'moon', 'crosshair', 'castle', 'pickaxe', 'key', 'rocket',
];

export function groupKey(profile: Pick<Profile, 'gameId' | 'url'>): string {
  if (profile.gameId !== 'site') return profile.gameId;
  try {
    return `site:${new URL(profile.url ?? '').host.replace(/^www\./, '')}`;
  } catch {
    return 'site:';
  }
}

export function groupLabel(key: string, gameName: (id: string) => string | undefined, names: Record<string, string> = {}): string {
  if (names[key]) return names[key];
  if (key.startsWith('site:')) return key.slice(5) || 'Outro site';
  return gameName(key) ?? key;
}

export function groupIcon(key: string, chosen: Record<string, string>): string {
  return chosen[key] ?? DEFAULT_ICONS[key] ?? 'gamepad-2';
}
