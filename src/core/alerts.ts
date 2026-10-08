// Alertas a partir da mudança de estado de uma conta. Só avisam; não agem no jogo.

import type { GameState } from '../sdk/types';

export interface Alert {
  profileId: string;
  kind: 'level' | 'stamina' | 'disconnected' | 'death';
  title: string;
  body: string;
  at: number;
}

export const STAMINA_ALERT_MIN = 60;

export function detectAlerts(prev: GameState | undefined, next: GameState, label: string): Alert[] {
  if (!prev) return [];
  const out: Alert[] = [];
  const base = { profileId: next.profileId, at: next.at };
  const r0 = prev.resources;
  const r1 = next.resources;

  const lv0 = prev.character.level;
  const lv1 = next.character.level;
  if (lv0 !== undefined && lv1 !== undefined && lv1 > lv0) {
    out.push({ ...base, kind: 'level', title: `${label} subiu de nível`, body: `Agora no nível ${lv1}.` });
  }
  if (r0.stamina_min !== undefined && r1.stamina_min !== undefined && r0.stamina_min > STAMINA_ALERT_MIN && r1.stamina_min <= STAMINA_ALERT_MIN) {
    out.push({ ...base, kind: 'stamina', title: `${label} com pouca stamina`, body: `Restam ${Math.floor(r1.stamina_min / 60)}h${String(r1.stamina_min % 60).padStart(2, '0')}.` });
  }
  if (!r0.disconnected && r1.disconnected) {
    out.push({ ...base, kind: 'disconnected', title: `${label} desconectou`, body: 'A conta caiu do servidor.' });
  }
  if ((r1.deaths ?? 0) > (r0.deaths ?? 0)) {
    out.push({ ...base, kind: 'death', title: `${label} morreu`, body: 'Confira equipamento, poções e a caça antes de voltar.' });
  }
  return out;
}
