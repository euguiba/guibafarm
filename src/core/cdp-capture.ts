// Lógica de captura sobre o protocolo de depuração do Chromium (CDP), independente
// de quem fala com o navegador: o depurador do Electron ou um WebSocket para o Edge.

import type { CapturedEvent } from '../sdk/types';

const TEXT_MIME = /json|text|javascript/i;
const MAX_BODY = 2_000_000;

export type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<any>;

export function hostMatches(url: string, hosts: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Devolve um tratador de eventos CDP que transforma tráfego dos hosts do jogo em CapturedEvent. */
export function createCaptureHandler(
  hosts: string[],
  send: SendCommand,
  onEvent: (event: CapturedEvent) => void,
): (method: string, params: any) => void {
  const pending = new Map<string, { url: string; status: number; mime: string }>();
  const sockets = new Map<string, string>(); // requestId -> url do WebSocket

  return (method, params) => {
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
        send('Network.getResponseBody', { requestId: params.requestId })
          .then((res: { body: string; base64Encoded: boolean }) => {
            const body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
            if (body.length <= MAX_BODY) {
              onEvent({ kind: 'http', url: info.url, status: info.status, mime: info.mime, at: Date.now(), body });
            }
          })
          .catch(() => {
            // corpo já descartado pelo navegador; segue
          });
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
}

export const NETWORK_ENABLE_PARAMS = { maxResourceBufferSize: 10_000_000, maxTotalBufferSize: 50_000_000 };
