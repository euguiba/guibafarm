// Assistente do painel lateral: responde perguntas sobre a conta usando o estado
// lido e o ranking do analisador. Usa ANTHROPIC_API_KEY (ou `ant auth login`).

import Anthropic from '@anthropic-ai/sdk';
import type { GameState, PriceBook, Recommendation } from '../sdk/types';

const MODEL = 'claude-opus-5-5';

const SYSTEM = `Você é o assistente de um navegador para jogos idle com mercado de dinheiro real (RMT).
Ajude o jogador a decidir caças, equipamentos, poderes e upgrades com o melhor retorno.
Use os números do estado da conta e das recomendações medidas; diga quando um número é estimado.
Se faltar um dado para decidir, diga qual dado falta.
Não sugira formas de burlar regras do jogo, limites de contas ou sistemas antibot.
Responda em português do Brasil, curto e direto.`;

export interface AssistantContext {
  gameName: string;
  state: GameState | undefined;
  recommendations: Recommendation[];
  prices: PriceBook;
  policyNote: string;
}

type Turn = { role: 'user' | 'assistant'; content: string };

export class Assistant {
  private client: Anthropic | undefined;
  private conversations = new Map<string, Turn[]>();

  private getClient(): Anthropic {
    this.client ??= new Anthropic();
    return this.client;
  }

  async ask(profileId: string, question: string, ctx: AssistantContext): Promise<string> {
    const turns = this.conversations.get(profileId) ?? [];
    const contextBlock = [
      `Jogo: ${ctx.gameName}`,
      `Política de automação: ${ctx.policyNote}`,
      `Estado atual: ${ctx.state ? JSON.stringify(ctx.state) : 'ainda não lido'}`,
      `Recomendações medidas: ${JSON.stringify(ctx.recommendations)}`,
      `Preços informados: ${JSON.stringify(ctx.prices)}`,
    ].join('\n');

    const userContent = `<contexto>\n${contextBlock}\n</contexto>\n\n${question}`;
    const params = {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // Se o modelo recusar, a API refaz o pedido no modelo de fallback recomendado.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [...turns, { role: 'user', content: userContent }],
    };

    let response: Anthropic.Beta.BetaMessage;
    try {
      // Os tipos do SDK podem ainda não ter `fallbacks: "default"`.
      response = await this.getClient().beta.messages.create(params as any);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return 'Configure ANTHROPIC_API_KEY para usar o assistente.';
      if (err instanceof Anthropic.RateLimitError) return 'Limite de uso da API atingido; tente de novo em instantes.';
      if (err instanceof Anthropic.APIConnectionError) return 'Sem conexão com a API do Claude.';
      if (err instanceof Anthropic.APIError) return `Erro da API (${err.status}): ${err.message}`;
      throw err;
    }

    if (response.stop_reason === 'refusal') return 'O assistente não respondeu a esta pergunta.';
    const answer = response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();

    // Guarda só a pergunta, sem o bloco de contexto, para o histórico não crescer a cada estado.
    turns.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    this.conversations.set(profileId, turns.slice(-20));
    return answer;
  }
}
