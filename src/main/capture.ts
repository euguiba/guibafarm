// Captura de rede da aba de uma conta pelo depurador embutido do Electron.
// Nada é injetado na página: a captura acontece do lado do navegador.
// Fica desligada quando ninguém lê a rede (jogo sem leitor de rede e sem gravação), porque
// acompanhar o tráfego custa memória e CPU em cada conta.

import type { WebContents } from 'electron';
import { createCaptureHandler, NETWORK_ENABLE_PARAMS } from '../core/cdp-capture';
import type { CapturedEvent } from '../sdk/types';

export { hostMatches } from '../core/cdp-capture';

export interface CaptureControl {
  /** Liga ou desliga a captura conforme alguém precise dela agora. */
  update(): void;
  detach(): void;
}

export function attachCapture(
  wc: WebContents,
  hosts: string[],
  onEvent: (event: CapturedEvent) => void,
  opts: { active: () => boolean; wantsBody: (url: string) => boolean },
): CaptureControl {
  const dbg = wc.debugger;
  const handle = createCaptureHandler(hosts, (method, params) => dbg.sendCommand(method, params), onEvent, opts.wantsBody);
  const onMessage = (_e: unknown, method: string, params: any) => handle(method, params);
  let on = false;

  const enable = () => {
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch (err) {
        console.warn('[capture] não foi possível anexar o depurador:', err);
        return;
      }
    }
    dbg.on('message', onMessage);
    dbg.sendCommand('Network.enable', NETWORK_ENABLE_PARAMS).catch((err) => console.warn('[capture] Network.enable falhou:', err));
    on = true;
  };
  const disable = () => {
    dbg.removeListener('message', onMessage);
    if (dbg.isAttached()) dbg.sendCommand('Network.disable').catch(() => {});
    on = false;
  };
  const update = () => {
    if (wc.isDestroyed()) return;
    const want = opts.active();
    if (want && !on) enable();
    else if (!want && on) disable();
  };
  update();
  return {
    update,
    detach: () => {
      if (wc.isDestroyed()) return;
      dbg.removeListener('message', onMessage);
      if (dbg.isAttached()) dbg.detach();
    },
  };
}
