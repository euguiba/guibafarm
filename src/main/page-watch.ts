// Lê o texto visível da aba de uma conta a cada poucos segundos, num "mundo isolado"
// do Electron: o script enxerga o DOM mas não as variáveis do jogo, e só lê.
// O log de combate é observado com MutationObserver para pegar cada linha nova uma vez.

import type { WebContents } from 'electron';
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

export function watchPage(wc: WebContents, reader: PageReader, onSnapshot: (snap: PageSnapshot) => void): () => void {
  const install = () => {
    wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: installScript(reader.logContainer, reader.logLine) }]).catch(() => {});
  };
  wc.on('dom-ready', install);

  const timer = setInterval(async () => {
    if (wc.isDestroyed() || wc.isLoading()) return;
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
    if (!wc.isDestroyed()) wc.removeListener('dom-ready', install);
  };
}
