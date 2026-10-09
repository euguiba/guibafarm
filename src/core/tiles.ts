// Grade de telas das contas: quantas cabem em cada modo e onde cada uma fica.
// Funções puras, usadas pela janela Electron e testadas sem navegador.

export type LayoutMode = '1x1' | 'split' | '2x2' | '3x3';

export const LAYOUTS: Record<LayoutMode, { cols: number; rows: number }> = {
  '1x1': { cols: 1, rows: 1 },
  split: { cols: 2, rows: 1 },
  '2x2': { cols: 2, rows: 2 },
  '3x3': { cols: 3, rows: 3 },
};

export function isLayoutMode(value: unknown): value is LayoutMode {
  return typeof value === 'string' && value in LAYOUTS;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Cell extends Rect {
  /** Conta mostrada nesta célula; vazio quando sobra espaço na grade. */
  profileId?: string;
}

export interface TileOptions {
  pad: number;
  gap: number;
  /** Fração da largura da primeira coluna e da altura da primeira linha (Split e 2x2). */
  ratios?: Ratios;
}

export interface Ratios {
  col: number;
  row: number;
}

export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

export function clampRatio(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round(v * 1000) / 1000)) : 0.5;
}

/** Tamanhos de cada coluna (ou linha): 2 divisões seguem a proporção; outras quantidades ficam iguais. */
function sizes(total: number, count: number, ratio: number): number[] {
  if (count === 2) {
    const first = Math.floor(total * ratio);
    return [first, total - first];
  }
  const each = Math.floor(total / count);
  return Array.from({ length: count }, () => each);
}

/** Contas que aparecem na grade, na ordem em que foram abertas; a selecionada sempre entra. */
export function visibleIds(mode: LayoutMode, openIds: string[], selected: string | undefined): string[] {
  const { cols, rows } = LAYOUTS[mode];
  const cap = cols * rows;
  if (mode === '1x1') return selected && openIds.includes(selected) ? [selected] : openIds.slice(0, 1);
  const shown = openIds.slice(0, cap);
  if (selected && openIds.includes(selected) && !shown.includes(selected)) shown[cap - 1] = selected;
  return shown;
}

export function computeCells(
  mode: LayoutMode,
  openIds: string[],
  selected: string | undefined,
  area: Rect,
  opts: TileOptions,
): Cell[] {
  const { cols, rows } = LAYOUTS[mode];
  const ids = visibleIds(mode, openIds, selected);
  const innerW = Math.max(0, area.width - 2 * opts.pad - (cols - 1) * opts.gap);
  const innerH = Math.max(0, area.height - 2 * opts.pad - (rows - 1) * opts.gap);
  const ws = sizes(innerW, cols, clampRatio(opts.ratios?.col ?? 0.5));
  const hs = sizes(innerH, rows, clampRatio(opts.ratios?.row ?? 0.5));
  const xs = ws.map((_, c) => area.x + opts.pad + ws.slice(0, c).reduce((a, b) => a + b, 0) + c * opts.gap);
  const ys = hs.map((_, r) => area.y + opts.pad + hs.slice(0, r).reduce((a, b) => a + b, 0) + r * opts.gap);
  const cells: Cell[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    cells.push({ x: xs[c], y: ys[r], width: ws[c], height: hs[r], profileId: ids[i] });
  }
  return cells;
}

/** O que a pessoa digitou na barra: endereço vira https, o resto vira busca. */
export function toAddress(input: string): string | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
