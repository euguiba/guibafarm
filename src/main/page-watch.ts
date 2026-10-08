// Lê o texto visível da aba de uma conta a cada poucos segundos, num "mundo isolado"
// do Electron: o script enxerga o DOM mas não as variáveis do jogo, e só lê.
// O log de combate é observado com MutationObserver para pegar cada linha nova uma vez.

import type { WebContents } from 'electron';
import { hostMatches } from '../core/cdp-capture';
import type { PageReader, PageSnapshot } from '../sdk/types';

const WORLD_ID = 1999;
const POLL_MS = 5_000;
const MAX_TEXT = 20_000;

function installScript(container: string | undefined, line: string | undefined): string {
  return `(() => {
    if (window.__niWatch) return true;
    const buf = [];
    const container = ${JSON.stringify(container ?? null)};
    const line = ${JSON.stringify(line ?? null)};
    let observed = null;
    const textOf = (node) => {
      if (!(node instanceof Element)) return '';
      const el = line ? node.querySelector(line) || (node.matches(line) ? node : null) : node;
      return el ? (el.textContent || '').trim() : '';
    };
    const attach = () => {
      if (!container) return;
      const el = document.querySelector(container);
      if (!el || el === observed) return;
      observed = el;
      // Linhas antigas não contam: só o que aparecer daqui em diante.
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) {
          const t = textOf(n);
          if (t) buf.push(t);
        }
        if (buf.length > 2000) buf.splice(0, buf.length - 2000);
      }).observe(el, { childList: true });
    };
    attach();
    setInterval(attach, 2000);
    window.__niWatch = {
      read: () => ({ text: (document.body ? document.body.innerText : '').slice(0, ${MAX_TEXT}), logLines: buf.splice(0) }),
    };
    return true;
  })()`;
}

export function watchPage(
  wc: WebContents,
  hosts: string[],
  reader: PageReader,
  onSnapshot: (snap: PageSnapshot) => void,
): () => void {
  const install = () => {
    wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: installScript(reader.logContainer, reader.logLine) }]).catch(() => {});
  };
  wc.on('dom-ready', install);
  // Página de erro (sem internet, servidor fora) mantém a URL do jogo; não ler nesse caso.
  let failed = false;
  const onStart = () => (failed = false);
  const onFail = (_e: unknown, _code: number, _desc: string, _url: string, isMainFrame: boolean) => {
    if (isMainFrame) failed = true;
  };
  wc.on('did-start-navigation', onStart);
  wc.on('did-fail-load', onFail);

  const timer = setInterval(async () => {
    // Só lê páginas do jogo; telas de erro ou de outros sites ficam de fora.
    if (wc.isDestroyed() || wc.isLoading() || failed || !hostMatches(wc.getURL(), hosts)) return;
    try {
      const res = (await wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [
        { code: 'window.__niWatch ? window.__niWatch.read() : null' },
      ])) as { text: string; logLines: string[] } | null;
      if (res) onSnapshot({ at: Date.now(), text: res.text, logLines: res.logLines });
      else install();
    } catch {
      // página trocando; tenta de novo no próximo ciclo
    }
  }, POLL_MS);

  return () => {
    clearInterval(timer);
    if (wc.isDestroyed()) return;
    wc.removeListener('dom-ready', install);
    wc.removeListener('did-start-navigation', onStart);
    wc.removeListener('did-fail-load', onFail);
  };
}
