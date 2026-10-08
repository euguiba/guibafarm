// Páginas de contas: cada jogo é um grupo, e cada site avulso ("Outro site") vira
// um grupo próprio pelo endereço, para as contas de jogos diferentes não se misturarem.

import type { Profile } from './store';

const DEFAULT_ICONS: Record<string, string> = {
  huntera: '⚔️',
  'poke-idle-world': '🐾',
  'leveling-idle': '🗡️',
  rollercoin: '🪙',
};

/** Ícones que a pessoa pode escolher para uma página. */
export const GROUP_ICONS = ['⚔️', '🗡️', '🛡️', '🏹', '🔮', '🐉', '🐾', '🔥', '💎', '👑', '🪙', '⭐', '🍀', '🚀', '🎯', '🌐'];

export function groupKey(profile: Pick<Profile, 'gameId' | 'url'>): string {
  if (profile.gameId !== 'site') return profile.gameId;
  try {
    return `site:${new URL(profile.url ?? '').host.replace(/^www\./, '')}`;
  } catch {
    return 'site:';
  }
}

export function groupLabel(key: string, gameName: (id: string) => string | undefined): string {
  if (key.startsWith('site:')) return key.slice(5) || 'Outro site';
  return gameName(key) ?? key;
}

export function groupIcon(key: string, chosen: Record<string, string>): string {
  return chosen[key] ?? DEFAULT_ICONS[key] ?? '🌐';
}
