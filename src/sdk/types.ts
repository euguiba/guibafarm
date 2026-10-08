// Contrato entre o núcleo do navegador e os módulos de cada jogo.
// O núcleo não conhece regras de nenhum jogo; tudo que é específico mora em src/games/<id>/.

/** Tráfego capturado da aba de uma conta (HTTP e WebSocket). */
export interface CapturedEvent {
  kind: 'http' | 'ws-in' | 'ws-out';
  url: string;
  at: number; // epoch ms
  status?: number;
  mime?: string;
  body: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  count: number;
}

/** Estado normalizado de uma conta num instante. */
export interface GameState {
  gameId: string;
  profileId: string;
  at: number; // epoch ms
  character: {
    name?: string;
    level?: number;
    experience?: number;
    vocation?: string;
  };
  /** Moedas e recursos numéricos: gold, diamonds, tokens... */
  resources: Record<string, number>;
  /** Mapa, caça ou área atual. */
  location?: string;
  inventory?: InventoryItem[];
}

/** Ação que um Actor sabe executar. */
export interface ActionRequest {
  kind: string;
  params: Record<string, unknown>;
}

export interface Recommendation {
  id: string;
  title: string;
  detail: string;
  /** Valor usado para ordenar (maior é melhor). */
  score: number;
  unit: string;
  action?: ActionRequest;
}

/** Preços informados pelo usuário ou coletados de mercados. */
export interface PriceBook {
  /** Reais por 1.000 unidades de cada moeda do jogo (ex.: gold). */
  currencyBrlPer1k: Record<string, number>;
  /** Reais por unidade de item, pelo id do item. */
  itemBrl: Record<string, number>;
}

export interface PriceQuote {
  key: string; // moeda ou id de item
  brl: number;
  per: number; // quantidade a que o preço se refere
  source: string;
  at: number;
}

export interface StateReader {
  /** Recebe um evento de rede e devolve o novo estado, ou undefined se o evento não muda nada. */
  onEvent(event: CapturedEvent, previous: GameState | undefined, profileId: string): GameState | undefined;
}

/** Texto visível da página do jogo, lido sem agir nela. */
export interface PageSnapshot {
  at: number;
  /** document.body.innerText, cortado. */
  text: string;
  /** Linhas novas do log de combate desde a leitura anterior. */
  logLines: string[];
}

export interface PageReader {
  /** Onde fica o log de combate e cada linha dele (seletores CSS). */
  logContainer?: string;
  logLine?: string;
  onSnapshot(snapshot: PageSnapshot, previous: GameState | undefined, profileId: string): GameState | undefined;
}

export interface Analyzer {
  analyze(history: GameState[], prices: PriceBook, now: number): Recommendation[];
}

export interface ActorContext {
  /** Executa JavaScript na página do jogo e devolve o resultado. */
  evaluate(js: string): Promise<unknown>;
  click(x: number, y: number): Promise<void>;
  log(message: string): void;
}

export interface Actor {
  perform(action: ActionRequest, ctx: ActorContext): Promise<void>;
}

/** Um trecho contínuo de caça num mesmo local, de uma conta. */
export interface HuntSession {
  profileId: string;
  location: string;
  start: number; // epoch ms
  end: number;
  level?: number;
  vocation?: string;
  experience: number;
  gold: number;
  xpPerHour: number;
  goldPerHour: number;
  brlPerHour?: number;
}

/** Sessões de um local somadas, de uma ou mais contas. */
export interface HuntSummary {
  location: string;
  profileIds: string[];
  sessions: number;
  minLevel?: number;
  maxLevel?: number;
  durationMs: number;
  experience: number;
  gold: number;
  xpPerHour: number;
  goldPerHour: number;
  brlPerHour?: number;
}

export interface HuntComparer {
  sessions(history: GameState[], prices: PriceBook): HuntSession[];
  summarize(sessions: HuntSession[], prices: PriceBook): HuntSummary[];
}

export interface MarketFeed {
  quotes(): Promise<PriceQuote[]>;
}

export interface GamePolicy {
  read: boolean;
  recommend: boolean;
  /** Automação só carrega quando true. Defina conforme as regras do jogo. */
  automate: boolean;
  /** Por que a política é essa; aparece na interface. */
  note: string;
}

export interface GameManifest {
  id: string;
  name: string;
  startUrl: string;
  /** Hosts que ativam o módulo e cujo tráfego é capturado. */
  hosts: string[];
  /** Limite de contas das regras do jogo; o navegador não deixa passar disso. */
  maxAccounts?: number;
  /** Vocações/classes do jogo, para marcar cada conta. Sem lista, o perfil não mostra nada. */
  roles?: GameRole[];
  policy: GamePolicy;
}

export interface GameRole {
  id: string;
  name: string;
  /** Sigla curta mostrada no selo da conta. */
  short: string;
  color: string;
}

export interface GameModule {
  manifest: GameManifest;
  reader: StateReader;
  pageReader?: PageReader;
  analyzer?: Analyzer;
  /** Compara caçadas entre sessões e contas do mesmo jogo. */
  hunts?: HuntComparer;
  actor?: Actor;
  market?: MarketFeed;
}
