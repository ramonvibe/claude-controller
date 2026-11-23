# Claude Controller

> [!WARNING]
> **Projeto descontinuado.** Não recebe mais manutenção. A ideia continua no novo projeto, o [Claude-Palace](https://github.com/ramonvibe/Claude-Palace).

App web local que reparte um pedido de desenvolvimento entre vários modelos para poupar a cota do Claude:

- O **Opus** planeja e escreve especificações curtas (handoffs).
- O **Haiku** codifica e revisa.
- O **DeepSeek**, via `dsh`, pode assumir tarefas delegáveis, como documentação.

O app usa o Claude Code já logado no terminal e não precisa de chave de API.

- **Qualquer IA de terceiros**, grátis ou paga, pode assumir as tarefas menores: OpenRouter, Gemini, Groq, DeepSeek e outras.

O maior ganho vem do **contexto enxuto**. Cada agente roda com o próprio system prompt e só as ferramentas de que precisa. Uma chamada mínima cai de cerca de 25 mil para cerca de 600 tokens de contexto base.

## Requisitos

- Node **24** ou mais novo
- Claude Code instalado e logado (`claude auth status` deve mostrar `"loggedIn": true`)
- Opcional: DeepSeek Harness (`dsh`), logado com a conta DeepSeek

## Instalar e iniciar

```bash
npm i
npm start
```

Abra **http://127.0.0.1:7777**. O servidor escuta só em `127.0.0.1` e gera um token novo a cada início.

Para ter o comando `claude-app`, que funciona em qualquer terminal e qualquer pasta, rode uma vez dentro do clone:

```bash
npm link
```

Depois, basta digitar `claude-app`. Ele gera a página e sobe o servidor, como o `npm start`. Use `npm link` e não `npm i -g`: o Node não roda arquivos `.ts` copiados para dentro de `node_modules`. Para remover o comando, rode `npm unlink -g claude-controller`.

## Primeiros passos

1. Em **Workspace**, informe o caminho do repositório em que os agentes vão trabalhar. Um workspace por vez.
2. Em **Comandos de teste**, liste os comandos que os agentes podem rodar (padrão: `npm test`).
3. Revise os cards. Os padrões são:
   - Planejador: Opus
   - Codificador: Haiku
   - Revisor: Haiku
   - Docs: DeepSeek

   Use **+** para adicionar cards. Em cada card dá para escolher:
   - o modelo: Opus, Sonnet, Haiku ou DeepSeek;
   - o **Tipo de Agente**;
   - os MCPs;
   - se o agente herda a sua configuração do Claude Code.
4. Escreva o pedido e clique em **Rodar orquestrado**. Para testar um card sozinho, use **Rodar só este**.

**Cores dos cards:**

| Cor | Significado |
|---|---|
| Verde | O agente tem tarefa em execução. Vários cards podem ficar verdes ao mesmo tempo. |
| Vermelho | A última tarefa do agente falhou. Fica assim até a próxima tarefa dele. |
| Cinza | Ocioso. |

O estado chega pelo WebSocket. Ao recarregar a página, ele é reconstruído a partir das tarefas em andamento no backend.

O topo da página mostra os **tokens de Opus**, que são a métrica principal, e o uso da cota de 5h e de 7d informado pelo Claude Code. O painel **Execuções** mostra, por run, os tokens e o custo de lista de cada agente e modelo.

## Modelos substitutos (para poupar o Claude)

Abra **Provedores**. A página tem duas partes:

- **Com login próprio:**
  - **DeepSeek via `dsh`** (free): o botão **Conectar** abre a página de login do `dsh web` e o app confere sozinho quando o login terminou.
  - **Gemini CLI** (free, login Google): o botão **Instalar** instala a CLI, e **Conectar** abre o login do Google pela própria CLI.
  - **Claude Code** (assinatura): use `claude auth login`.
- **Via API:** escolha um provedor no catálogo, marcado como **(free)** ou **(paga)**. Coloque a chave no arquivo `.env` desta pasta (por exemplo `OPENROUTER_API_KEY=...`). Depois clique em **Verificar e buscar modelos** e marque os modelos. No OpenRouter, os modelos `:free` aparecem como free.

Modelos de API leem e editam arquivos por um loop de ferramentas. As regras são as mesmas dos agentes Claude: só dentro do workspace, sem acesso a `.env` e segredos, sem commit e só com os comandos de teste.

Na tela principal, a tabela **Quem faz cada tipo de tarefa** define, por categoria, o card e o reserva. O Opus classifica cada tarefa em uma destas categorias: arquitetura, feature, mudança pequena, testes ou documentação. Exemplo:

| Categoria | Card |
|---|---|
| Arquitetura | Opus high |
| Feature | Haiku medium |
| Mudança pequena | um modelo free do OpenRouter |
| Docs | DeepSeek |

**Skills padrão:** marque as skills que valem para todos os agentes. O app lista as suas skills do Claude Code e mostra quantos tokens cada uma custa por chamada. Cada card pode usar uma lista própria.

## Níveis de delegação

Um nível de delegação é um canal com nome que o planejador (Opus) escolhe para cada tarefa, pelo menor custo que não erre. O nível já fixa papel e categoria, então o planejador só escreve o corpo do handoff. Assim o trabalho vai ao modelo certo sem o planejador escolher card por card.

**Padrões** (`server/tiers.ts`). Todos vêm ligados, sem card fixo (automático por papel e categoria) e com revisão:

| Nível (`id`) | Papel | Quando usar |
|---|---|---|
| `coder-chief` | coder | lógica complexa ou vital, que não pode falhar |
| `coder-major` | coder | trabalho médio, seguindo o desenho existente |
| `coder-minor` | coder | edição pequena, delimitada e mecânica, sem lógica |
| `tester` | tester | escrever testes |
| `docs-writer` | docs | documentação |

Sugestão de card para os níveis de código: chief com Opus ou Haiku, major com DeepSeek, minor com um modelo free.

**Editar em Configurar > Níveis de delegação.** Cada nível tem:

- **Ativo:** nível desligado não entra na lista do planejador nem vira ferramenta MCP.
- **Nome:** rótulo na tela.
- **Ferramenta:** o `id` do nível. No MCP, `-` vira `_` (`coder-chief` → `coder_chief`).
- **Papel** e **Categoria:** o handoff do nível herda os dois.
- **Quando usar:** o texto que o planejador lê para escolher o nível (até 500 caracteres).
- **Card** e **Reserva:** agentes na ordem, até 5; vazio = automático pelo papel e pela categoria.
- **Revisão:** liga ou desliga a revisão só para esse nível.
- **Adicionar nível** cria outro (até 12 no total); **Remover** apaga.

**Regras do `id`:** começa com letra minúscula, seguida de letras minúsculas, números ou `-`, com até 31 caracteres. O `id` deve ser único. O servidor recusa o salvamento se não cumprir isso.

**Ordem de fallback** (`Orchestrator.route`), para cada handoff:

1. Substituição do preflight, só nesta execução.
2. Agentes do nível, na ordem.
3. Rota da categoria em Roteamento.
4. Outros agentes do mesmo papel. Em papéis delegáveis, externos vêm primeiro; depois, os menos ocupados.
5. Qualquer agente coder, como último recurso.

Uma falha de provedor passa para o próximo candidato, mas só antes de qualquer revisão. Se o executor devolver `blocked` ou estourar o limite de revisões, a tarefa escala para o Planejador.

**Tarefas sensíveis** nunca vão para provedores externos: esses agentes saem da lista em todas as etapas acima, e o nível cai para um agente não externo (Claude, no padrão).

**Exemplo:** Planejador Opus; `coder-chief` Haiku; `coder-major` DeepSeek; `coder-minor` um modelo free (OpenRouter ou Gemini). O planejador manda o trivial para o free, o médio para o DeepSeek e só o complexo para o Haiku.

### Ferramentas MCP dos níveis (modo agente)

No modo agente, cada nível vira uma ferramenta do MCP orq. Os nomes são estes:

| Nível | Ferramenta | Papel | Card padrão |
|---|---|---|---|
| `coder-chief` | `coder_chief` | arquitetura, código complexo ou vital | Haiku |
| `coder-major` | `coder_major` | feature | DeepSeek |
| `coder-minor` | `coder_minor` | mudança pequena | Gemini CLI (grátis) |

**Ativar:** `coder-major` e `coder-minor` vêm desligados. Em **Configurar > Níveis de delegação**, marque **Ativo** na linha do nível.

**Editar as dicas:** o texto de **Quando usar** é a dica que o planejador Opus lê para escolher o nível. Edite o texto nessa mesma tela e salve.

## Acompanhar e economizar

- **Antes de rodar**, o app confere se as IAs escolhidas estão conectadas. Se alguma não estiver, ele pergunta antes de usar outra; nunca cai no Claude sem avisar.
- **Linha do tempo:** em cada pedido aparece a cota de 5h antes e depois, os tokens do Opus e quanto foi feito fora do Claude. Cada tarefa mostra quem fez, a categoria, o que recebeu, as ferramentas usadas, os arquivos alterados, o diff e os tokens (novos · cache · saída).
- **Economia:** tokens de cada IA no período (24h, 7 dias, 30 dias ou tudo), quanto ficou fora do Claude e o custo de lista. Em "Disponível", aparecem:
  - a cota do Claude (% usada em 5h e 7 dias);
  - o saldo do OpenRouter e da DeepSeek API (com chave);
  - os limites `x-ratelimit-*` da última resposta de cada provedor.

  O DeepSeek pelo `dsh` não informa saldo.
- **Em Configurar:**
  - **Mapa do repositório:** um modelo grátis resume o projeto e o Opus planeja lendo esse resumo.
  - **Revisão por categoria.**
  - **Modo Pipeline**, que gasta menos Opus que o modo Agente.

## Como funciona

- **Pipeline** (padrão):
  1. O Planejador devolve um plano em JSON validado (`--json-schema`).
  2. Cada handoff vai ao agente do papel certo e depois ao Revisor.
  3. Se o executor devolver `blocked` ou estourar o limite de revisões, a tarefa escala para o Opus.
  4. Se um provedor falhar (por exemplo, DeepSeek sem login), a tarefa vai para o próximo agente da cadeia.

  As tarefas rodam em sequência. A opção **Paralelo** é experimental e roda ao mesmo tempo handoffs sem arquivos em comum.
- **Agente:** o Opus recebe o servidor MCP `orq` e delega sozinho com `delegate_task`. É mais flexível, mas gasta mais tokens de Opus.
- **Permissões:**
  - Todo agente Claude roda com `--permission-mode dontAsk` e uma allowlist explícita: ler e editar arquivos do workspace, rodar os comandos de teste e `git diff`, `git status` e `git log`.
  - São sempre negados: `git commit`, `git push`, `rm` recursivo e a leitura de `.env`, `*.pem` e `*.key`.
  - Commit é sempre com você.
- **MCPs:** a config é gerada por tarefa (arquivo `0600`, apagado ao fim) e passada com `--strict-mcp-config`. A sua configuração global do Claude Code nunca é alterada.

## Diagnóstico

O link **Diagnóstico** mostra, para cada provedor, a versão, o estado de autenticação e as flags da CLI de que o app depende. Ele também lista os presets de MCP e mede quantos tokens cada um soma por chamada (duas chamadas enxutas no Haiku).

O DeepSeek aparece como **"não autenticado"** enquanto o modo headless do `dsh` não enxergar o login da conta. Veja `DECISOES.md`.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `CC_PORT` | Porta (padrão `7777`) |
| `CC_DATA` | Pasta do banco SQLite e das configs MCP temporárias (padrão `./data`) |
| `CLAUDE_BIN`, `DSH_BIN` | Caminhos alternativos das CLIs |
| `GITHUB_TOKEN` | Habilita o preset MCP do GitHub |
| `CC_ENV_FILE` | Arquivo de chaves dos provedores via API (padrão `./.env`) |
| `GEMINI_BIN` | Caminho da Gemini CLI (sem ele, o app usa `npx @google/gemini-cli@0.65.0`) |
| `DSH_PERMISSION_MODE` | Modo do sandbox do `dsh` (padrão do `dsh`: `workspace-write`) |

## Testes

```bash
npm test         # sem custo: usa CLIs falsas que reproduzem as fixtures em fixtures/
LIVE=1 npm test  # chamadas reais ao Claude (alguns centavos de preço de lista)
```

## Estrutura

```
server/            backend (Node 24 roda .ts direto)
  adapters/        um arquivo por provedor; adicionar um provedor = adicionar um arquivo
  orchestrator.ts  pipeline, roteamento, revisão, escalonamento, modo agente
  tiers.ts         níveis de delegação (card, reserva, revisão, ferramenta MCP)
  roles.ts         templates de papel e permissões
mcp/orq.ts         servidor MCP próprio
web/               UI (React + Vite)
fixtures/          saídas reais gravadas das CLIs
PLANO.md           especificação
DECISOES.md        fatos verificados e desvios do plano
docs/ARQUITETURA.md  arquitetura, API e como adicionar provedor
```
