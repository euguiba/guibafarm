// Captura de rede da aba de uma conta pelo protocolo de depuração do Chromium.
// Lê respostas HTTP de texto/JSON e frames de WebSocket dos hosts do jogo.
// Nada é injetado na página: a captura acontece do lado do navegador.

import type { WebContents } from 'electron';
import type { CapturedEvent } from '../sdk/types';

const TEXT_MIME = /json|text|javascript/i;
const MAX_BODY = 2_000_000;

interface PendingResponse {
  url: string;
  status: number;
  mime: string;
}

export function hostMatches(url: string, hosts: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export function attachCapture(
  wc: WebContents,
  hosts: string[],
  onEvent: (event: CapturedEvent) => void,
): () => void {
  const dbg = wc.debugger;
  const pending = new Map<string, PendingResponse>();
  const sockets = new Map<string, string>(); // requestId -> url do WebSocket

  try {
    dbg.attach('1.3');
  } catch (err) {
    console.warn('[capture] não foi possível anexar o depurador:', err);
    return () => {};
  }

  const onMessage = async (_e: unknown, method: string, params: any) => {
    switch (method) {
      case 'Network.responseReceived': {
        const { requestId, response } = params;
        if (hostMatches(response.url, hosts) && TEXT_MIME.test(response.mimeType ?? '')) {
          pending.set(requestId, { url: response.url, status: response.status, mime: response.mimeType });
        }
        break;
      }
      case 'Network.loadingFinished': {
        const info = pending.get(params.requestId);
        if (!info) break;
        pending.delete(params.requestId);
        try {
          const res = (await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })) as {
            body: string;
            base64Encoded: boolean;
          };
          const body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
          if (body.length <= MAX_BODY) onEvent({ kind: 'http', url: info.url, status: info.status, mime: info.mime, at: Date.now(), body });
        } catch {
          // corpo já descartado pelo navegador; segue
        }
        break;
      }
      case 'Network.loadingFailed':
        pending.delete(params.requestId);
        break;
      case 'Network.webSocketCreated':
        if (hostMatches(params.url, hosts)) sockets.set(params.requestId, params.url);
        break;
      case 'Network.webSocketClosed':
        sockets.delete(params.requestId);
        break;
      case 'Network.webSocketFrameReceived':
      case 'Network.webSocketFrameSent': {
        const url = sockets.get(params.requestId);
        if (!url || params.response?.opcode !== 1) break; // só frames de texto
        onEvent({
          kind: method === 'Network.webSocketFrameReceived' ? 'ws-in' : 'ws-out',
          url,
          at: Date.now(),
          body: params.response.payloadData,
        });
        break;
      }
    }
  };

  dbg.on('message', onMessage);
  dbg.sendCommand('Network.enable', { maxResourceBufferSize: 10_000_000, maxTotalBufferSize: 50_000_000 }).catch((err) => {
    console.warn('[capture] Network.enable falhou:', err);
  });

  return () => {
    dbg.removeListener('message', onMessage);
    if (dbg.isAttached()) dbg.detach();
  };
}
