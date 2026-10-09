// Alertas a partir da mudança de estado de uma conta. Só avisam; não agem no jogo.

import type { GameState } from '../sdk/types';

export interface Alert {
  profileId: string;
  kind: 'level' | 'stamina' | 'disconnected' | 'death' | 'notice';
  /** Tipo mais fino para não repetir o mesmo aviso (ex.: notice "no-ball"). */
  key?: string;
  title: string;
  body: string;
  at: number;
}

export const STAMINA_ALERT_MIN = 60;
/** Subida maior que isso de uma leitura para outra não é subir de nível: é texto de outra coisa. */
const MAX_LEVEL_STEP = 5;
/** O mesmo aviso, da mesma conta, não se repete antes disso. */
export const ALERT_COOLDOWN_MS = 10 * 60_000;
/** Avisos que viram notificação do Windows; os outros ficam só na lista do app. */
export const NOTIFY_KINDS = new Set<Alert['kind']>(['disconnected', 'death', 'notice']);

export function detectAlerts(prev: GameState | undefined, next: GameState, label: string): Alert[] {
  if (!prev) return [];
  const out: Alert[] = [];
  const base = { profileId: next.profileId, at: next.at };
  const r0 = prev.resources;
  const r1 = next.resources;

  const lv0 = prev.character.level;
  const lv1 = next.character.level;
  if (lv0 !== undefined && lv1 !== undefined && lv1 > lv0 && lv1 - lv0 <= MAX_LEVEL_STEP) {
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

/** Filtra avisos repetidos: o mesmo tipo, da mesma conta, só uma vez a cada ALERT_COOLDOWN_MS. */
export class AlertGate {
  private readonly last = new Map<string, number>();

  allow(alert: Alert): boolean {
    // Nível que sobe de verdade sempre passa; o resto espera o intervalo.
    const key = `${alert.profileId}:${alert.kind}:${alert.key ?? ''}`;
    const prev = this.last.get(key);
    if (alert.kind !== 'level' && prev !== undefined && alert.at - prev < ALERT_COOLDOWN_MS) return false;
    this.last.set(key, alert.at);
    return true;
  }
}
