# Navegador Idle

Navegador desktop (Electron) para jogos idle com RMT: uma aba isolada por conta, leitura do estado do jogo pela rede, analisador por jogo, assistente com Claude e lucro por hora em reais.

Piloto: **Huntera**. Poke Idle World, Leveling Idle e RollerCoin já abrem com perfis isolados e leitor genérico, sem analisador ainda.

## Rodar

Precisa de Node 22 ou mais novo.

```bash
npm install
npm start
```

Para o assistente, defina `ANTHROPIC_API_KEY` antes de `npm start` (ou faça `ant auth login`).

Testes: `npm test`.

## Como usar

1. Escolha o jogo, dê um apelido e clique em **Adicionar conta**. Cada conta ganha uma partição própria: login, cookies e dados não se misturam.
2. Clique em **Abrir** e faça login normalmente. O login fica salvo naquela partição.
3. Jogue com a aba aberta. O painel mostra o estado lido, as recomendações e o assistente.
4. Em **Preços**, informe quantos reais valem 1.000 de ouro para ver o lucro em R$/h.
5. **Grade** mostra todas as contas abertas lado a lado.

## Mapear o protocolo do Huntera

O leitor do Huntera ainda usa nomes de campo prováveis (`src/games/huntera/index.ts`, `HUNTERA_FIELDS`). Para acertar:

1. Abra uma conta do Huntera e clique em **Gravar tráfego**.
2. Jogue uns 15 minutos: troque de caça, venda algo, use o mercado.
3. Clique em **Parar gravação**. O arquivo `.jsonl` fica na pasta que o app mostra ao começar a gravar.
4. Mande o arquivo; com ele o leitor passa a usar os campos reais e o analisador ganha itens, loot e preços do mercado.

A gravação pode conter dados da sua conta (nome, token de sessão em URLs). Não publique o arquivo.

## Estrutura

```
src/
  sdk/            contrato dos módulos (types.ts) e leitor JSON genérico
  games/          um módulo por jogo; huntera/ é o piloto
  main/           processo principal: perfis, abas, captura de rede, assistente, automação
  ui/             barra lateral
```

- **Captura** (`core/cdp-capture.ts`): usa o protocolo de depuração do Chromium para ler respostas HTTP e frames de WebSocket dos hosts do jogo. Nada é injetado na página do jogo.
- **Analisador do Huntera** (`games/huntera/analyzer.ts`): mede ouro e XP por hora em cada caça (mínimo de 5 minutos por trecho), recomenda a melhor caça para lucro e para XP, sugere troca quando a atual rende menos de 70% da melhor e alerta quando a XP para de subir por 10 minutos.
- **Automação** (`core/actions.ts`): só liga quando a política do jogo permite e o módulo tem um `actor`. Hoje está desligada nos quatro jogos (veja abaixo).

## Política por jogo

| Jogo | Automação | Motivo |
| --- | --- | --- |
| Huntera | Desligada | As regras do jogo não aceitam automação; o módulo só lê e recomenda |
| Poke Idle World | Desligada | Regras proíbem scripts, extensões e macros sem permissão da staff; limite de 4 contas |
| Leveling Idle | Desligada | Sem regras públicas; confirmar com a staff |
| RollerCoin | Desligada | Termos 1.10 e 2.2 proíbem bots e macros |

Para ligar num jogo: mude `policy.automate` no manifesto e implemente o `actor` do módulo.
