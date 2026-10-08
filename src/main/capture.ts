// Captura de rede da aba de uma conta pelo depurador embutido do Electron.
// Nada é injetado na página: a captura acontece do lado do navegador.

import type { WebContents } from 'electron';
import { createCaptureHandler, NETWORK_ENABLE_PARAMS } from '../core/cdp-capture';
import type { CapturedEvent } from '../sdk/types';

export { hostMatches } from '../core/cdp-capture';

export function attachCapture(
  wc: WebContents,
  hosts: string[],
  onEvent: (event: CapturedEvent) => void,
): () => void {
  const dbg = wc.debugger;
  try {
    dbg.attach('1.3');
  } catch (err) {
    console.warn('[capture] não foi possível anexar o depurador:', err);
    return () => {};
  }

  const handle = createCaptureHandler(hosts, (method, params) => dbg.sendCommand(method, params), onEvent);
  const onMessage = (_e: unknown, method: string, params: any) => handle(method, params);
  dbg.on('message', onMessage);
  dbg.sendCommand('Network.enable', NETWORK_ENABLE_PARAMS).catch((err) => {
    console.warn('[capture] Network.enable falhou:', err);
  });

  return () => {
    dbg.removeListener('message', onMessage);
    if (dbg.isAttached()) dbg.detach();
  };
}
