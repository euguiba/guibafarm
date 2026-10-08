// Barra lateral. Arquivo de script (sem import/export) porque roda direto na página.

interface UiGame {
  id: string;
  name: string;
  maxAccounts?: number;
  hasAnalyzer: boolean;
  hasHunts: boolean;
  hasActor: boolean;
  policy: { read: boolean; recommend: boolean; automate: boolean; note: string };
}

interface UiProfile {
  id: string;
  gameId: string;
  group: string;
  zoom?: number;
  label: string;
  open: boolean;
  recording: boolean;
}

interface UiState {
  profileId: string;
  at: number;
  character: { name?: string; level?: number; experience?: number; vocation?: string };
  resources: Record<string, number>;
  location?: string;
}

interface UiRecommendation {
  id: string;
  title: string;
  detail: string;
  score: number;
  unit: string;
  action?: { kind: string; params: Record<string, unknown> };
}

interface UiAlert {
  profileId: string;
  kind: string;
  title: string;
  body: string;
  at: number;
}

interface UiHuntSession {
  profileId: string;
  location: string;
  start: number;
  end: number;
  level?: number;
  xpPerHour: number;
  goldPerHour: number;
  brlPerHour?: number;
}

interface UiHuntSummary {
  location: string;
  profileIds: string[];
  sessions: number;
  minLevel?: number;
  maxLevel?: number;
  durationMs: number;
  xpPerHour: number;
  goldPerHour: number;
  brlPerHour?: number;
}

interface UiHuntComparison {
  level?: number;
  levelBand: number;
  labels: Record<string, string>;
  summaries: UiHuntSummary[];
  recent: UiHuntSession[];
}

interface UiPrices {
  currencyBrlPer1k: Record<string, number>;
  itemBrl: Record<string, number>;
}

interface UiTile {
  x: number;
  y: number;
  width: number;
  height: number;
  head: number;
  profileId?: string;
  label?: string;
  game?: string;
  url?: string;
  muted?: boolean;
  focused?: boolean;
  zoom?: number;
  scale?: number;
}

interface UiTiles {
  mode: string;
  turbo: boolean;
  selected?: string;
  open: number;
  overlay: boolean;
  tiles: UiTile[];
}

interface UiMetrics {
  cpu: number;
  ramMb: number;
  perProfile: Record<string, { cpu: number; ramMb: number }>;
}

interface UiSettings {
  layout: string;
  turbo: boolean;
  sidebarCollapsed: boolean;
  resolution: number;
  turboResolution: number;
  defaultZoom: number;
  gpu: boolean;
}

interface Window {
  api: {
    listGames(): Promise<UiGame[]>;
    listProfiles(): Promise<UiProfile[]>;
    addProfile(gameId: string, label: string, address?: string): Promise<{ profile?: UiProfile; warning?: string; error?: string }>;
    removeProfile(id: string): Promise<void>;
    openProfile(id: string): Promise<void>;
    closeProfile(id: string): Promise<void>;
    setLayout(mode: string): Promise<void>;
    getSettings(): Promise<UiSettings>;
    setSettings(patch: Partial<UiSettings>): Promise<UiSettings>;
    listGroups(): Promise<{ groups: UiGroup[]; icons: string[] }>;
    setGroup(key: string): Promise<void>;
    setGroupIcon(key: string, icon: string): Promise<void>;
    setZoom(id: string, zoom: number): Promise<number | undefined>;
    setOverlay(hidden: boolean): Promise<void>;
    relaunch(): Promise<void>;
    setSidebarCollapsed(collapsed: boolean): Promise<void>;
    setTurbo(on: boolean): Promise<void>;
    selectView(id: string): Promise<void>;
    reloadView(id?: string): Promise<void>;
    muteView(id: string, muted: boolean): Promise<void>;
    getMetrics(): Promise<UiMetrics>;
    go(id: string, input: string): Promise<boolean>;
    setRecording(id: string, on: boolean): Promise<string>;
    getState(id: string): Promise<UiState | undefined>;
    listAlerts(): Promise<UiAlert[]>;
    getRecommendations(id: string): Promise<UiRecommendation[]>;
    compareHunts(id: string, opts: { allAccounts: boolean; nearLevel: boolean }): Promise<UiHuntComparison | undefined>;
    getPrices(): Promise<UiPrices>;
    setPrices(prices: UiPrices): Promise<void>;
    setAutomation(id: string, on: boolean): Promise<boolean>;
    runAction(id: string, rec: UiRecommendation): Promise<string>;
    ask(id: string, question: string): Promise<string>;
    on(channel: 'state' | 'recommendations' | 'log' | 'alert' | 'tiles', listener: (payload: any) => void): void;
  };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let games: UiGame[] = [];
let selectedId: string | undefined;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function gameById(id: string): UiGame | undefined {
  return games.find((g) => g.id === id);
}

function num(n: number | undefined): string {
  return n === undefined ? '—' : n.toLocaleString('pt-BR');
}

interface UiGroup {
  key: string;
  label: string;
  icon: string;
  count: number;
  open: number;
  max?: number;
  active: boolean;
}

let groupIcons: string[] = [];
let activeGroup: UiGroup | undefined;

// Barra lateral: faixa de páginas (uma por jogo) e a lista de contas da página aberta.
async function renderProfiles(): Promise<void> {
  const [profiles, data] = await Promise.all([window.api.listProfiles(), window.api.listGroups()]);
  groupIcons = data.icons;
  activeGroup = data.groups.find((g) => g.active);
  renderGroups(data.groups);

  const mine = profiles.filter((p) => p.group === activeGroup?.key);
  const list = $('profile-list');
  list.replaceChildren();
  for (const p of mine) list.append(profileItem(p, gameById(p.gameId)!));
  if (profiles.length === 0) list.append(el('li', 'empty-note', 'Nenhuma conta ainda. Adicione a primeira abaixo.'));

  $('group-icon').textContent = activeGroup?.icon ?? '🎮';
  $('group-title').textContent = activeGroup?.label ?? 'Contas';
  $('group-count').textContent = activeGroup ? (activeGroup.max ? `${activeGroup.count}/${activeGroup.max}` : String(activeGroup.count)) : '';
  $('group-count').hidden = !activeGroup;
  renderRailAccounts(mine);
  $('empty').hidden = mine.some((p) => p.open);
}

function renderGroups(groups: UiGroup[]): void {
  const box = $('group-list');
  box.replaceChildren();
  for (const g of groups) {
    const b = el('button', 'page', g.icon);
    if (g.active) b.classList.add('active');
    b.title = `${g.label} · ${g.count} ${g.count === 1 ? 'conta' : 'contas'}${g.open ? `, ${g.open} aberta${g.open === 1 ? '' : 's'}` : ''}`;
    if (g.open) b.append(el('span', 'page-badge', String(g.open)));
    b.addEventListener('click', async () => {
      await window.api.setGroup(g.key);
      showAddForm(false);
      await renderProfiles();
    });
    box.append(b);
  }
}

// Com a barra recolhida, a faixa também mostra as contas da página aberta.
function renderRailAccounts(profiles: UiProfile[]): void {
  const rail = $('rail-accounts');
  rail.replaceChildren();
  for (const p of profiles) {
    const b = el('button', 'avatar', initials(p.label));
    b.style.setProperty('--acc', colorOf(p.id));
    if (p.open) b.classList.add('open');
    if (p.id === selectedId) b.classList.add('selected');
    b.title = `${p.label}${p.open ? '' : ' (fechada)'}`;
    b.addEventListener('click', async () => {
      if (!p.open) await window.api.openProfile(p.id);
      await select(p.id);
    });
    rail.append(b);
  }
}

function renderIconPicker(): void {
  const picker = $('icon-picker');
  picker.replaceChildren();
  for (const icon of groupIcons) {
    const b = el('button', 'pick', icon);
    b.addEventListener('click', async () => {
      if (activeGroup) await window.api.setGroupIcon(activeGroup.key, icon);
      picker.hidden = true;
      await renderProfiles();
    });
    picker.append(b);
  }
}

async function setCollapsed(collapsed: boolean): Promise<void> {
  document.body.classList.toggle('collapsed', collapsed);
  await window.api.setSidebarCollapsed(collapsed);
}

/** Abre o formulário já no jogo da página aberta; `fresh` deixa escolher outro jogo (página nova). */
function showAddForm(show: boolean, fresh = false): void {
  $('add-form').hidden = !show;
  $('new-account').hidden = show;
  if (!show) {
    $('add-warning').hidden = true;
    return;
  }
  const sel = $<HTMLSelectElement>('game-select');
  const site = $<HTMLInputElement>('site-input');
  if (!fresh && activeGroup) {
    sel.value = activeGroup.key.startsWith('site:') ? 'site' : activeGroup.key;
    site.value = activeGroup.key.startsWith('site:') ? activeGroup.key.slice(5) : '';
  } else {
    site.value = '';
  }
  site.hidden = sel.value !== 'site';
  $<HTMLInputElement>('label-input').focus();
}

// Cada conta ganha uma cor fixa (pela id), repetida na lista, na faixa recolhida e no cabeçalho da tela.
const ACCOUNT_COLORS = ['#e0b04a', '#5ab0f5', '#a78bfa', '#f2877b', '#34d399', '#f5a35a', '#5fd4d0', '#e57ab8'];

function colorOf(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCOUNT_COLORS[h % ACCOUNT_COLORS.length];
}

function initials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const text = words.length > 1 ? words[0][0] + words[1][0] : label.trim().slice(0, 2);
  return text.toUpperCase() || '?';
}

function profileItem(p: UiProfile, game: UiGame): HTMLElement {
  const li = el('li');
  li.style.setProperty('--acc', colorOf(p.id));
  if (p.id === selectedId) li.classList.add('selected');
  if (p.open) li.classList.add('open');
  const top = el('div', 'item-top');
  top.append(el('i', 'dot'), el('div', 'name', p.label), el('i', 'status'));
  const sub = el('div', 'item-sub');
  sub.append(el('span', undefined, p.open ? 'Aberta' : 'Fechada'));
  if (p.recording) sub.append(el('span', 'rec-on', 'gravando'));
  if (p.open) {
    const metric = el('span', 'item-metric');
    metric.dataset.profile = p.id;
    sub.append(metric);
  }
  const actions = el('div', 'actions');
  const button = (label: string, onClick: () => Promise<void>) => {
    const b = el('button', undefined, label);
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await onClick();
      await renderProfiles();
    });
    actions.append(b);
  };
  if (p.open) button('Fechar', () => window.api.closeProfile(p.id));
  else button('Abrir', async () => { await window.api.openProfile(p.id); await select(p.id); });
  if (game.policy.read) {
    button(p.recording ? 'Parar gravação' : 'Gravar', async () => {
      const dir = await window.api.setRecording(p.id, !p.recording);
      if (!p.recording) alert(`Gravando o tráfego desta conta em:\n${dir}`);
    });
  }
  button('Remover', async () => {
    if (!confirm(`Remover a conta "${p.label}"? O login salvo nesta partição deixa de ser usado.`)) return;
    await window.api.removeProfile(p.id);
    if (selectedId === p.id) { selectedId = undefined; $('detail').hidden = true; }
  });
  li.append(top, sub, actions);
  li.addEventListener('click', () => void select(p.id));
  return li;
}

// Cabeçalhos das telas: desenhados aqui, na posição que o processo principal calculou.
let lastTiles: UiTiles | undefined;

function renderTiles(data: UiTiles): void {
  lastTiles = data;
  const layer = $('tile-layer');
  layer.replaceChildren();
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === data.mode));
  setTurboButton(data.turbo);
  $('empty').hidden = data.open > 0;
  if (data.open === 0 || data.overlay) return;
  for (const t of data.tiles) {
    const frame = el('div', 'tile-frame');
    Object.assign(frame.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.width}px`, height: `${t.height}px` });
    if (!t.profileId) {
      frame.classList.add('empty');
      frame.append(el('div', 'tile-empty', 'Tela livre · abra outra conta na barra lateral'));
      layer.append(frame);
      continue;
    }
    const id = t.profileId;
    if (t.focused) frame.classList.add('focused');
    frame.style.setProperty('--acc', colorOf(id));
    const head = el('div', 'tile-head');
    head.style.height = `${t.head}px`;
    let host = '';
    try { host = t.url ? new URL(t.url).host : ''; } catch { host = ''; }
    head.append(
      el('i', 'dot'),
      el('span', 'tile-name', t.label ?? ''),
      el('span', 'tile-game', t.game ?? ''),
      el('span', 'tile-url', host),
      el('span', 'tile-metric', ''),
    );
    head.querySelector<HTMLElement>('.tile-metric')!.dataset.profile = id;
    if (t.scale !== undefined && t.scale < 1) {
      const res = el('span', 'tile-res', `${Math.round(t.scale * 100)}%`);
      res.title = 'Resolução desta tela (configurações de desempenho)';
      head.append(res);
    }
    const zoom = t.zoom ?? 1;
    const zoomBox = el('span', 'tile-zoom');
    const zbtn = (label: string, title: string, next: number) => {
      const b = el('button', 'icon', label);
      b.title = title;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); void window.api.setZoom(id, next); });
      return b;
    };
    zoomBox.append(zbtn('−', 'Diminuir o zoom', zoom - 0.1), el('span', 'zoom-value', `${Math.round(zoom * 100)}%`), zbtn('+', 'Aumentar o zoom', zoom + 0.1));
    zoomBox.querySelector('.zoom-value')!.addEventListener('click', (ev) => { ev.stopPropagation(); void window.api.setZoom(id, 1); });
    (zoomBox.querySelector('.zoom-value') as HTMLElement).title = 'Voltar para 100%';
    head.append(zoomBox);
    const icon = (label: string, title: string, onClick: () => Promise<unknown>) => {
      const b = el('button', 'icon', label);
      b.title = title;
      b.addEventListener('click', async (ev) => { ev.stopPropagation(); await onClick(); });
      head.append(b);
    };
    icon(t.muted ? '🔇' : '🔈', t.muted ? 'Ligar o som' : 'Silenciar', () => window.api.muteView(id, !t.muted));
    icon('⟳', 'Recarregar', () => window.api.reloadView(id));
    icon('⤢', 'Ver só esta tela', async () => { await window.api.setLayout('1x1'); await select(id); });
    icon('✕', 'Fechar a conta', async () => { await window.api.closeProfile(id); await renderProfiles(); });
    head.addEventListener('click', () => void select(id));
    frame.append(head);
    layer.append(frame);
    if (t.focused && document.activeElement !== $('url-input')) $<HTMLInputElement>('url-input').value = t.url ?? '';
  }
  void pollMetrics();
}

function setTurboButton(on: boolean): void {
  const b = $('turbo');
  b.classList.toggle('on', on);
  b.querySelector('b')!.textContent = on ? 'on' : 'off';
}

async function pollMetrics(): Promise<void> {
  try {
    const m = await window.api.getMetrics();
    $('m-cpu').textContent = `${m.cpu.toFixed(1)}%`;
    $('m-ram').textContent = `${Math.round(m.ramMb)} MB`;
    document.querySelectorAll<HTMLElement>('.tile-metric, .item-metric').forEach((span) => {
      const v = m.perProfile[span.dataset.profile ?? ''];
      span.textContent = v ? `CPU ${v.cpu.toFixed(1)}%  ·  ${Math.round(v.ramMb)} MB` : '';
    });
  } catch {
    // janela fechando
  }
}

// Nome legível dos recursos; os que não estão aqui ficam de fora do painel.
const RESOURCE_LABELS: Record<string, (v: number, r: Record<string, number>) => string | undefined> = {
  gold: (v) => num(v),
  diamonds: (v) => num(v),
  huntera_coins: (v) => num(v),
  stamina_min: (v) => `${Math.floor(v / 60)}h${String(v % 60).padStart(2, '0')}`,
  capacity_oz: (v) => `${num(v)} oz`,
  xp_pct: (v) => `${v}%`,
  xp_log: (v) => num(v),
  biggest_hit: (v) => num(v),
  damage_log: (v, r) => (r.hits_log ? `${num(v)} em ${num(r.hits_log)} acertos` : num(v)),
  deaths: (v) => num(v),
  disconnected: (v) => (v ? 'sim' : 'não'),
};
const RESOURCE_NAMES: Record<string, string> = {
  gold: 'Ouro',
  diamonds: 'Diamantes',
  huntera_coins: 'Huntera Coins',
  stamina_min: 'Stamina',
  capacity_oz: 'Capacidade',
  xp_pct: 'XP do nível',
  xp_log: 'XP no log',
  biggest_hit: 'Maior hit',
  damage_log: 'Dano no log',
  deaths: 'Mortes',
  disconnected: 'Desconectado',
};

function renderAlerts(alerts: UiAlert[]): void {
  const ul = $<HTMLUListElement>('alerts');
  ul.replaceChildren();
  if (alerts.length === 0) {
    ul.append(el('li', 'muted', 'Nenhum alerta ainda.'));
    return;
  }
  for (const a of alerts.slice(0, 8)) {
    const li = el('li', 'rec alert');
    li.append(el('div', 'title', a.title), el('div', undefined, `${a.body} · ${new Date(a.at).toLocaleTimeString('pt-BR')}`));
    ul.append(li);
  }
}

function renderState(state: UiState | undefined): void {
  const dl = $<HTMLDListElement>('state');
  dl.replaceChildren();
  if (!state) {
    dl.append(el('dt', undefined, 'Estado'), el('dd', 'muted', 'ainda não lido; jogue um pouco com a aba aberta'));
    return;
  }
  const rows: [string, string][] = [
    ['Personagem', state.character.name ?? '—'],
    ['Nível', num(state.character.level)],
    ['XP', num(state.character.experience)],
    ['Local', state.location ?? '—'],
    ...Object.entries(state.resources).flatMap(([k, v]) => {
      const show = RESOURCE_LABELS[k]?.(v, state.resources);
      return show === undefined ? [] : [[RESOURCE_NAMES[k] ?? k, show] as [string, string]];
    }),
    ['Atualizado', new Date(state.at).toLocaleTimeString('pt-BR')],
  ];
  for (const [k, v] of rows) dl.append(el('dt', undefined, k), el('dd', undefined, v));
}

function renderRecs(recs: UiRecommendation[]): void {
  const ul = $<HTMLUListElement>('recs');
  ul.replaceChildren();
  if (recs.length === 0) {
    ul.append(el('li', 'muted', 'Sem dados suficientes ainda. Cada caça precisa de pelo menos 5 minutos medidos.'));
    return;
  }
  for (const r of recs) {
    const li = el('li', r.id === 'idle-alert' ? 'rec alert' : 'rec');
    li.append(el('div', 'title', r.title), el('div', undefined, r.detail));
    if (r.action && selectedId) {
      const b = el('button', undefined, 'Executar');
      const id = selectedId;
      b.addEventListener('click', async () => alert(await window.api.runAction(id, r)));
      li.append(b);
    }
    ul.append(li);
  }
}

function brl(n: number): string {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

function levelRange(min?: number, max?: number): string {
  if (min === undefined || max === undefined) return 'nível ?';
  return min === max ? `nível ${min}` : `nível ${min}–${max}`;
}

function rates(r: { xpPerHour: number; goldPerHour: number; brlPerHour?: number }): string {
  const parts = [`${num(Math.round(r.goldPerHour))} ouro/h`, `${num(Math.round(r.xpPerHour))} XP/h`];
  if (r.brlPerHour !== undefined) parts.unshift(`${brl(r.brlPerHour)}/h`);
  return parts.join(' · ');
}

async function renderHunts(): Promise<void> {
  const id = selectedId;
  const section = $('hunts-section');
  const game = games.find((g) => g.id === currentGameId);
  section.hidden = !game?.hasHunts;
  if (!id || section.hidden) return;

  const data = await window.api.compareHunts(id, {
    allAccounts: $<HTMLInputElement>('hunts-all').checked,
    nearLevel: $<HTMLInputElement>('hunts-near').checked,
  });
  if (id !== selectedId || !data) return;
  $('hunts-near-label').textContent =
    data.level === undefined ? 'Perto do meu nível (nível ainda não lido)' : `Perto do meu nível (${data.level} ± ${data.levelBand})`;

  const byXp = $<HTMLSelectElement>('hunts-sort').value === 'xp';
  const money = (s: UiHuntSummary) => s.brlPerHour ?? s.goldPerHour;
  const sorted = [...data.summaries].sort((a, b) => (byXp ? b.xpPerHour - a.xpPerHour : money(b) - money(a)));

  const ul = $<HTMLUListElement>('hunts');
  ul.replaceChildren();
  if (sorted.length === 0) {
    ul.append(el('li', 'muted', 'Nenhuma caçada medida ainda. Cada trecho num local precisa de pelo menos 5 minutos.'));
  }
  sorted.forEach((s, i) => {
    const li = el('li', i === 0 ? 'hunt best' : 'hunt');
    const title = el('div', 'title');
    title.append(el('span', undefined, `${i + 1}. ${s.location}`), el('span', 'muted', duration(s.durationMs)));
    const accounts = s.profileIds.map((p) => data.labels[p] ?? p).join(', ');
    li.append(
      title,
      el('div', 'rates', rates(s)),
      el('div', 'badge', `${levelRange(s.minLevel, s.maxLevel)} · ${s.sessions} ${s.sessions === 1 ? 'sessão' : 'sessões'} · ${accounts}`),
    );
    ul.append(li);
  });

  const sessions = $<HTMLUListElement>('hunt-sessions');
  sessions.replaceChildren();
  for (const s of data.recent) {
    const when = new Date(s.start).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const who = data.labels[s.profileId] ?? s.profileId;
    const li = el('li');
    li.append(
      el('div', undefined, `${when} · ${who} · ${s.location} · ${duration(s.end - s.start)}${s.level !== undefined ? ` · nível ${s.level}` : ''}`),
      el('div', 'muted rates', rates(s)),
    );
    sessions.append(li);
  }
  if (data.recent.length === 0) sessions.append(el('li', 'muted', 'Nenhuma sessão ainda.'));
}

let currentGameId: string | undefined;

async function select(id: string): Promise<void> {
  selectedId = id;
  const profiles = await window.api.listProfiles();
  const p = profiles.find((x) => x.id === id);
  if (!p) return;
  const game = gameById(p.gameId);
  currentGameId = p.gameId;
  $('detail').hidden = false;
  const title = $('detail-title');
  title.style.setProperty('--acc', colorOf(p.id));
  title.replaceChildren(el('i', 'dot'), el('span', undefined, p.label), el('span', 'pill', game?.name ?? p.gameId));
  renderState(await window.api.getState(id));
  renderRecs(await window.api.getRecommendations(id));
  await renderHunts();
  const auto = $<HTMLInputElement>('automation');
  auto.checked = false;
  auto.disabled = !(game?.policy.automate && game.hasActor);
  $('automation-box').hidden = auto.disabled;
  $('policy-note').textContent = game?.policy.note ?? '';
  $('chat').replaceChildren();
  if (p.open) await window.api.selectView(id);
  await renderProfiles();
}

// Janela de configurações de desempenho. Enquanto ela está aberta, as telas dos jogos ficam escondidas.
async function openSettings(open: boolean): Promise<void> {
  $('settings').hidden = !open;
  await window.api.setOverlay(open);
  if (open) syncSettings(await window.api.getSettings());
}

let gpuAtStart: boolean | undefined;

function syncSettings(s: UiSettings): void {
  gpuAtStart ??= s.gpu;
  document.querySelectorAll<HTMLElement>('[data-setting]').forEach((group) => {
    const value = Number(s[group.dataset.setting as 'resolution' | 'turboResolution' | 'defaultZoom']);
    group.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.value) === value));
  });
  $<HTMLInputElement>('set-turbo').checked = s.turbo;
  $<HTMLInputElement>('set-gpu').checked = s.gpu;
  $('restart-note').hidden = s.gpu === gpuAtStart;
  setTurboButton(s.turbo);
}

function initSettings(): void {
  for (const id of ['open-settings', 'topbar-settings']) $(id).addEventListener('click', () => void openSettings(true));
  $('close-settings').addEventListener('click', () => void openSettings(false));
  $('settings').addEventListener('click', (ev) => { if (ev.target === $('settings')) void openSettings(false); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('settings').hidden) void openSettings(false); });
  document.querySelectorAll<HTMLElement>('[data-setting]').forEach((group) =>
    group.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', async () => syncSettings(await window.api.setSettings({ [group.dataset.setting!]: Number(b.dataset.value) }))),
    ),
  );
  $('set-turbo').addEventListener('change', async (ev) => {
    await window.api.setTurbo((ev.target as HTMLInputElement).checked);
    syncSettings(await window.api.getSettings());
  });
  $('set-gpu').addEventListener('change', async (ev) => syncSettings(await window.api.setSettings({ gpu: (ev.target as HTMLInputElement).checked })));
  $('relaunch').addEventListener('click', () => void window.api.relaunch());
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', async () => {
      const weak = b.dataset.preset === 'fraco';
      await window.api.setTurbo(weak);
      syncSettings(await window.api.setSettings(weak
        ? { resolution: 0.75, turboResolution: 0.5, defaultZoom: 0.8 }
        : { resolution: 1, turboResolution: 0.75, defaultZoom: 1 }));
    }),
  );
}

async function init(): Promise<void> {
  games = await window.api.listGames();
  const sel = $<HTMLSelectElement>('game-select');
  for (const g of games) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    sel.append(opt);
  }

  const site = $<HTMLInputElement>('site-input');
  sel.addEventListener('change', () => { site.hidden = sel.value !== 'site'; });

  $('add-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const label = $<HTMLInputElement>('label-input');
    const res = await window.api.addProfile(sel.value, label.value, site.value);
    const warn = $('add-warning');
    warn.hidden = !(res.warning || res.error);
    warn.textContent = res.warning ?? res.error ?? '';
    if (res.profile) { label.value = ''; site.value = ''; showAddForm(false); }
    await renderProfiles();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((b) =>
    b.addEventListener('click', () => void window.api.setLayout(b.dataset.layout!)),
  );
  $('collapse').addEventListener('click', () => void setCollapsed(true));
  $('expand').addEventListener('click', () => void setCollapsed(false));
  $('new-page').addEventListener('click', () => { void setCollapsed(false); showAddForm(true, true); });
  $('cancel-add').addEventListener('click', () => showAddForm(false));
  $('group-icon').addEventListener('click', () => {
    const picker = $('icon-picker');
    if (picker.hidden) renderIconPicker();
    picker.hidden = !picker.hidden;
  });
  initSettings();
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.key.toLowerCase() === 'b') {
      ev.preventDefault();
      void setCollapsed(!document.body.classList.contains('collapsed'));
    }
  });
  $('new-account').addEventListener('click', () => showAddForm(true));
  $('turbo').addEventListener('click', () => void window.api.setTurbo(!$('turbo').classList.contains('on')));
  $('reload-all').addEventListener('click', () => void window.api.reloadView());
  $('url-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const target = lastTiles?.selected;
    const input = $<HTMLInputElement>('url-input');
    input.blur();
    if (!target || !(await window.api.go(target, input.value))) {
      input.value = '';
      input.placeholder = 'Abra uma conta primeiro; o endereço abre na conta em foco';
    }
  });
  window.api.on('tiles', (data: UiTiles) => renderTiles(data));
  const settings = await window.api.getSettings();
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((b) => b.classList.toggle('active', b.dataset.layout === settings.layout));
  setTurboButton(settings.turbo);
  if (settings.sidebarCollapsed) void setCollapsed(true);
  setInterval(() => void pollMetrics(), 2000);
  void pollMetrics();

  const prices = await window.api.getPrices();
  const gold = $<HTMLInputElement>('gold-price');
  gold.value = prices.currencyBrlPer1k.gold?.toString() ?? '';
  gold.addEventListener('change', async () => {
    const current = await window.api.getPrices();
    const value = parseFloat(gold.value);
    if (Number.isFinite(value)) current.currencyBrlPer1k.gold = value;
    else delete current.currencyBrlPer1k.gold;
    await window.api.setPrices(current);
    if (selectedId) renderRecs(await window.api.getRecommendations(selectedId));
    await renderHunts();
  });

  $<HTMLInputElement>('automation').addEventListener('change', async (ev) => {
    const box = ev.target as HTMLInputElement;
    if (!selectedId) return;
    const ok = await window.api.setAutomation(selectedId, box.checked);
    if (!ok) box.checked = false;
  });

  $('ask-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const input = $<HTMLInputElement>('question');
    const question = input.value.trim();
    if (!question || !selectedId) return;
    input.value = '';
    const chat = $('chat');
    chat.append(el('div', 'q', question));
    const answer = el('div', 'a muted', 'pensando...');
    chat.append(answer);
    answer.textContent = await window.api.ask(selectedId, question);
    answer.classList.remove('muted');
    chat.scrollTop = chat.scrollHeight;
  });

  window.api.on('state', (state: UiState) => {
    if (state.profileId === selectedId) renderState(state);
  });
  window.api.on('recommendations', (p: { profileId: string; recommendations: UiRecommendation[] }) => {
    if (p.profileId !== selectedId) return;
    renderRecs(p.recommendations);
    void renderHunts();
  });
  window.api.on('alert', async () => renderAlerts(await window.api.listAlerts()));
  for (const fid of ['hunts-all', 'hunts-near', 'hunts-sort']) $(fid).addEventListener('change', () => void renderHunts());
  window.api.on('log', (entry: { profileId: string; message: string }) => console.log('[automação]', entry.profileId, entry.message));

  renderAlerts(await window.api.listAlerts());
  await renderProfiles();
}

void init();
