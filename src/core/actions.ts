// Executa ações de automação de um módulo, só quando a política do jogo permite
// e o usuário ligou a automação naquela conta. Toda ação passa por limite de ritmo e log.

import type { ActionRequest, ActorContext, GameModule } from '../sdk/types';

const MIN_INTERVAL_MS = 2_000;

/** Controle da página de uma conta, fornecido pelo navegador em uso (Electron ou Edge). */
export interface PageControl {
  evaluate(js: string): Promise<unknown>;
  click(x: number, y: number): Promise<void>;
}

export class ActionRunner {
  private enabled = new Set<string>();
  private lastRun = new Map<string, number>();

  constructor(private readonly log: (profileId: string, message: string) => void) {}

  canAutomate(game: GameModule): boolean {
    return game.manifest.policy.automate && game.actor !== undefined;
  }

  setEnabled(profileId: string, game: GameModule, on: boolean): boolean {
    if (on && !this.canAutomate(game)) return false;
    if (on) this.enabled.add(profileId);
    else this.enabled.delete(profileId);
    return true;
  }

  stopAll(): void {
    this.enabled.clear();
  }

  async run(profileId: string, game: GameModule, page: PageControl, action: ActionRequest): Promise<string> {
    if (!this.canAutomate(game)) return `Automação desligada para ${game.manifest.name}: ${game.manifest.policy.note}`;
    if (!this.enabled.has(profileId)) return 'Ligue a automação nesta conta antes.';
    const now = Date.now();
    if (now - (this.lastRun.get(profileId) ?? 0) < MIN_INTERVAL_MS) return 'Aguarde um instante entre ações.';
    this.lastRun.set(profileId, now);

    const ctx: ActorContext = {
      evaluate: (js) => page.evaluate(js),
      click: (x, y) => page.click(x, y),
      log: (message) => this.log(profileId, message),
    };
    this.log(profileId, `ação ${action.kind} ${JSON.stringify(action.params)}`);
    await game.actor!.perform(action, ctx);
    return 'Ação executada.';
  }
}
