// Diagnóstico local: registro de falhas em userData/logs/app.log (nada sai do PC) e uma marca de
// "app aberto" que mostra, na abertura seguinte, se a anterior caiu em vez de fechar normalmente.

import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';

const MAX_LOG_BYTES = 1_000_000;

function logFile(): string {
  return join(app.getPath('userData'), 'logs', 'app.log');
}

export function log(message: string): void {
  try {
    const file = logFile();
    mkdirSync(join(file, '..'), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    const mem = `livre ${Math.round(freemem() / 1048576)}/${Math.round(totalmem() / 1048576)} MB`;
    appendFileSync(file, `${new Date().toISOString()} [${mem}] ${message}\n`);
  } catch {
    // sem disco: segue sem registro
  }
}

function markerFile(): string {
  return join(app.getPath('userData'), 'running.lock');
}

/** Marca que o app está aberto; devolve true se a abertura anterior não fechou normalmente. */
export function markRunning(): boolean {
  const crashed = existsSync(markerFile());
  try {
    writeFileSync(markerFile(), String(process.pid));
  } catch {
    // sem disco
  }
  return crashed;
}

export function markClosed(): void {
  rmSync(markerFile(), { force: true });
}

export function watchProcesses(): void {
  process.on('uncaughtException', (err) => log(`erro no processo principal: ${err.stack ?? err}`));
  process.on('unhandledRejection', (err) => log(`promessa rejeitada: ${(err as Error)?.stack ?? err}`));
  app.on('child-process-gone', (_e, d) => log(`processo ${d.type} caiu: ${d.reason} (código ${d.exitCode})`));
  app.on('render-process-gone', (_e, wc, d) => log(`página caiu (${wc.getURL().slice(0, 80)}): ${d.reason} (código ${d.exitCode})`));
  // Memória do app de 5 em 5 minutos, para ver se algo cresce sem parar.
  setInterval(() => {
    const metrics = app.getAppMetrics();
    const mb = (kb: number) => Math.round(kb / 1024);
    const total = metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0);
    const byType = new Map<string, number[]>();
    for (const m of metrics) byType.set(m.type, [...(byType.get(m.type) ?? []), mb(m.memory.workingSetSize)]);
    const detail = [...byType].map(([type, list]) => `${type} ${list.sort((a, b) => b - a).join('+')}`).join(', ');
    log(`memória do app ${mb(total)} MB em ${metrics.length} processos (${detail})`);
  }, 5 * 60_000).unref();
}
