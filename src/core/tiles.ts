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
  const cw = Math.floor(innerW / cols);
  const ch = Math.floor(innerH / rows);
  const cells: Cell[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    cells.push({
      x: area.x + opts.pad + c * (cw + opts.gap),
      y: area.y + opts.pad + r * (ch + opts.gap),
      width: cw,
      height: ch,
      profileId: ids[i],
    });
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
