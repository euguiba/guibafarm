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

interface Window {
  api: {
    listGames(): Promise<UiGame[]>;
    listProfiles(): Promise<UiProfile[]>;
    addProfile(gameId: string, label: string): Promise<{ profile?: UiProfile; warning?: string; error?: string }>;
    removeProfile(id: string): Promise<void>;
    openProfile(id: string): Promise<void>;
    closeProfile(id: string): Promise<void>;
    setLayout(mode: 'single' | 'grid'): Promise<void>;
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
    on(channel: 'state' | 'recommendations' | 'log' | 'alert', listener: (payload: any) => void): void;
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

async function renderProfiles(): Promise<void> {
  const list = $<HTMLUListElement>('profile-list');
  const profiles = await window.api.listProfiles();
  list.replaceChildren();
  for (const p of profiles) {
    const li = el('li');
    if (p.id === selectedId) li.classList.add('selected');
    li.append(el('div', 'name', p.label), el('div', 'badge', `${gameById(p.gameId)?.name ?? p.gameId}${p.recording ? ' · gravando' : ''}`));
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
    button(p.recording ? 'Parar gravação' : 'Gravar tráfego', async () => {
      const dir = await window.api.setRecording(p.id, !p.recording);
      if (!p.recording) alert(`Gravando o tráfego desta conta em:\n${dir}`);
    });
    button('Remover', async () => {
      if (!confirm(`Remover a conta "${p.label}"? O login salvo nesta partição deixa de ser usado.`)) return;
      await window.api.removeProfile(p.id);
      if (selectedId === p.id) { selectedId = undefined; $('detail').hidden = true; }
    });
    li.append(actions);
    li.addEventListener('click', () => void select(p.id));
    list.append(li);
  }
  $('empty').textContent = profiles.some((p) => p.open) ? '' : 'Adicione uma conta e clique em Abrir.';
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
  $('detail-title').textContent = `${p.label} · ${game?.name ?? p.gameId}`;
  renderState(await window.api.getState(id));
  renderRecs(await window.api.getRecommendations(id));
  await renderHunts();
  const auto = $<HTMLInputElement>('automation');
  auto.checked = false;
  auto.disabled = !(game?.policy.automate && game.hasActor);
  $('automation-box').hidden = auto.disabled;
  $('policy-note').textContent = game?.policy.note ?? '';
  $('chat').replaceChildren();
  await renderProfiles();
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

  $('add-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const label = $<HTMLInputElement>('label-input');
    const res = await window.api.addProfile(sel.value, label.value);
    const warn = $('add-warning');
    warn.hidden = !(res.warning || res.error);
    warn.textContent = res.warning ?? res.error ?? '';
    label.value = '';
    await renderProfiles();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((b) =>
    b.addEventListener('click', async () => {
      document.querySelectorAll('[data-layout]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      await window.api.setLayout(b.dataset.layout as 'single' | 'grid');
    }),
  );

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
