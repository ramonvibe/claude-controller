# Claude Controller — Plano

App web local que orquestra vários modelos num mesmo fluxo de desenvolvimento. O Opus planeja e decide, o Haiku codifica e o DeepSeek (via `dsh`) pega o que for delegável. Tudo roda com o Claude Code já autenticado no terminal.

## 0. O que foi verificado nesta máquina (21/10/2026)

Antes de planejar, conferi o ambiente. Nada abaixo é suposição.

| Item | Resultado |
|---|---|
| Claude Code | `2.1.306`; `claude auth status` devolve JSON: `loggedIn: true`, `authMethod: "claude.ai"`, `subscriptionType: "pro"` |
| Modo não interativo | `-p/--print` |
| Saída | `--output-format text\|json\|stream-json`; `--include-partial-messages` (só com stream-json) |
| Entrada contínua | `--input-format stream-json` (processo vivo recebendo várias mensagens) |
| Modelo | `--model <alias\|nome>`; `--fallback-model`; `--effort low..max` |
| Saída estruturada | `--json-schema <schema>` (só com `--print`) |
| Orçamento | `--max-budget-usd` (só com `--print`) |
| Contexto enxuto | `--system-prompt`, `--tools`, `--strict-mcp-config`, `--mcp-config`, `--disable-slash-commands`, `--setting-sources`, `--no-session-persistence` |
| Permissões | `--permission-mode`, `--allowed-tools`, `--disallowed-tools`, `--permission-prompts host\|none` |
| Isolamento | `-w/--worktree` (worktree git por sessão) |
| MCP | `claude mcp add/list/get/remove/serve`; `claude mcp serve` expõe o próprio Claude Code como servidor MCP |
| `--bare` | **Inutilizável aqui**: a ajuda diz que com `--bare` a autenticação é *strictly* `ANTHROPIC_API_KEY`, sem OAuth |
| `dsh` | DeepSeek Harness `0.2.1-rc.2` (pacote `deepseek-harness-bin`). Tem os perfis `web` e `headless`. `dsh --profile headless --json "<tarefa>"` emite eventos NDJSON. Também aceita stdin e `--session-id` |
| Credencial DeepSeek | `DEEPSEEK_API_KEY` **não** está definida. O perfil cita `apiKeyEnv: DEEPSEEK_API_KEY`, mas também tem os plugins `dsh-llm-deepseek-account` e `dsh-mcp-client`. Modelo padrão: `deepseek-flash` |
| Runtime | Node `v24.21.0`, npm, Python 3.14 |

**Medição real** (o mesmo prompt "Responda só: ok" no Haiku, com `--output-format json`):

| Configuração | cache_creation | cache_read | custo (lista) |
|---|---|---|---|
| Padrão (CLAUDE.md, plugins, hooks, ferramentas, MCPs) | 16.446 | 8.920 | US$ 0,00338 |
| Enxuta (`--system-prompt` próprio, `--tools ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--setting-sources ""`) | 599 | 0 | US$ 0,00012 |

Cada chamada padrão carrega uns **25 mil tokens de contexto base**. A configuração enxuta corta isso para cerca de 600 tokens, ou seja, 28× mais barata nesse caso extremo. Esse é o maior ganho do projeto, maior até que trocar Opus por Haiku. O JSON de resultado traz `usage`, `modelUsage[<modelo>]` (com `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`, `canonicalModel` e `costBasis: "list"`), `total_cost_usd`, `num_turns` e `session_id`.

---

## 1. Arquitetura

```
┌────────────── Navegador (localhost) ──────────────┐
│  Grade de cards (+)   Painel de atividade   Economia│
└───────────▲ REST (config)        ▲ WebSocket (eventos)
            │                      │
┌───────────┴──────────────────────┴────────────────┐
│ Backend Node (um processo, 127.0.0.1 apenas)      │
│                                                   │
│  Registry ── agentes, provedores, presets MCP     │
│  Orquestrador ── fila de tarefas, roteador, regras│
│  Event bus ── normaliza eventos de todos adapters │
│  Store (SQLite) ── runs, tarefas, eventos, usage  │
│  Adapters de provedor (plugáveis):                │
│    claude-cli │ dsh-headless │ (futuro) http-*    │
└──────┬──────────────┬──────────────────▲──────────┘
       │ spawn        │ spawn            │ HTTP local + token
       ▼              ▼                  │
  claude -p ...   dsh --profile      ┌───┴─────────────┐
  (Opus/Haiku)    headless --json    │ MCP "orq" (stdio)│
       │                             │ delegate_task,   │
       └── --mcp-config ────────────►│ task_status, ... │
                                     └──────────────────┘
```

**Fluxo de um pedido:**

1. Você digita o pedido na UI e escolhe o workspace (um repositório).
2. O orquestrador cria um *Run* e manda o pedido ao agente do tipo **Planejador** (Opus).
3. O Planejador devolve um plano validado por `--json-schema`: uma lista de *handoffs* curtos (seção 4).
4. O roteador entrega cada handoff ao agente do tipo certo (Codificador/Haiku, Docs/DeepSeek etc.). Handoffs que não mexem nos mesmos arquivos rodam em paralelo.
5. Cada adapter transforma a saída do provedor em eventos padrão (`started`, `delta`, `tool_use`, `result`, `usage`, `error`). Os eventos vão para o SQLite e, pelo WebSocket, para a UI.
6. O Revisor (Haiku por padrão, Opus só quando escalado) confere o resultado contra os critérios de aceite. Se reprovar, o código volta ao Codificador com uma nota curta. São no máximo N voltas, e depois a tarefa escala para o Opus.
7. O Run termina com um resumo e o total de tokens por agente e por modelo.

**Dois modos de delegação:**

- **Pipeline** (padrão): o backend conduz. O Opus só planeja e, se preciso, arbitra. Não fica com o contexto aberto esperando subtarefas.
- **Agente**: o Opus recebe o MCP `orq` e chama `delegate_task` sozinho. É mais flexível, mas cada ida e volta de ferramenta reenvia o contexto do Opus. Por isso o `orq` devolve só resumos curtos, nunca diffs ou logs.

As credenciais de provedores externos ficam só no backend (variáveis de ambiente ou o armazenamento do próprio `dsh`). A UI nunca as recebe. O backend escuta apenas em `127.0.0.1` e exige um token gerado na inicialização, também na ponte com o MCP `orq`.

## 2. Stack sugerida

| Camada | Escolha | Por quê |
|---|---|---|
| Runtime | **Node 24 + TypeScript** | Já está instalado. Claude Code e `dsh` também são Node. O SDK MCP de referência é TS |
| HTTP/WS | **Fastify** + `@fastify/websocket` | Leve, tipado, serve o build estático da UI no mesmo processo |
| Persistência | **`node:sqlite`** (embutido no Node 24) | Sem dependência nativa para compilar, o que simplifica a instalação |
| Processos | `node:child_process.spawn` + leitor NDJSON por linha | Os dois provedores atuais são CLIs que emitem JSON por linha |
| MCP próprio | **`@modelcontextprotocol/sdk`**, transporte stdio | Padrão aceito por `--mcp-config`. Stdio dispensa porta extra |
| Validação | **zod** (com conversão para JSON Schema) | O mesmo esquema valida o handoff no backend e alimenta `--json-schema` |
| UI | **React + Vite**, CSS simples | Cards e painel ao vivo cabem em poucos componentes. O build vira arquivos estáticos |
| Empacotamento | Monorepo npm workspaces (`server`, `web`, `mcp-orq`) publicado como um pacote com `bin` | Instalação: `npx claude-controller` ou `npm i -g` e depois `claude-controller` |

Não uso Docker nem banco externo. Isso evitaria uma barreira de instalação, e um app local de um usuário não precisa deles.

## 3. Modelo de dados

```jsonc
// Agent: um card na grade
{
  "id": "ag_01",
  "name": "Codificador 1",
  "provider": "claude-cli",          // id de um Provider
  "model": "haiku",                  // repassado a --model; o real vem de modelUsage.canonicalModel
  "role": "coder",                   // planner | coder | reviewer | tester | docs | custom
  "systemPrompt": null,              // null = template do papel; texto = sobrescreve
  "effort": "medium",
  "tools": ["Read", "Edit", "Write", "Bash(npm test*)", "Bash(git diff*)"],
  "mcps": ["git"],                   // ids de McpPreset
  "permissionMode": "acceptEdits",
  "inheritUserConfig": false,        // true = não usa os flags enxutos (carrega CLAUDE.md, plugins, hooks)
  "limits": { "maxBudgetUsd": 0.5, "maxReviewLoops": 2, "timeoutSec": 600 },
  "concurrency": 1,
  "enabled": true
}

// Provider: um adapter configurado
{
  "id": "dsh",
  "adapter": "dsh-headless",         // implementação registrada
  "settings": { "profile": "headless" },
  "credentialEnv": null,             // nome da variável, nunca o valor
  "priceTable": { "deepseek-flash": { "inUsdPerMTok": null, "outUsdPerMTok": null } } // pergunta em aberto
}

// McpPreset
{
  "id": "git",
  "label": "Git",
  "transport": "stdio",
  "command": "npx", "args": ["-y", "<pacote>"],
  "envRefs": [],                     // nomes de variáveis lidas no backend
  "schemaTokens": 1840,              // medido uma vez (seção 5); mostrado no card
  "providers": ["claude-cli"]        // onde funciona
}

// Run, Task, Event (persistidos)
Run   { id, workspace, prompt, mode: "orchestrated" | "baseline-opus" | "baseline-opus-lean", status, startedAt, totals }
Task  { id, runId, parentId, role, agentId, handoff (JSON), status, result (JSON), attempts, sessionId }
Event { id, runId, taskId, agentId, ts, kind, payload }   // kind: started|delta|tool_use|handoff|result|usage|error
Usage { taskId, model, input, output, cacheRead, cacheCreate, costUsdList, source: "claude-json" | "dsh-events" | "estimado" }
```

**Contrato do adapter** (o núcleo só conhece isto):

```
detect()  -> { ok, version, auth, capabilities }      // roda ao iniciar e na página "Diagnóstico"
run(task, agent, signal) -> AsyncIterable<EventoPadrao> // termina com 'result' + 'usage'
models()  -> string[]                                   // para o seletor do card
```

Para adicionar um provedor, basta criar um arquivo em `server/adapters/` e registrá-lo. O orquestrador não muda.

**Montagem da chamada `claude-cli`** (com `inheritUserConfig: false`):

```
claude -p --model <model> --effort <effort>
  --output-format stream-json [flags que a fase 0 confirmar]
  --system-prompt <template do papel>
  --tools <lista> --allowed-tools <lista> --permission-mode <modo>
  --strict-mcp-config --mcp-config <arquivo gerado por agente>
  --disable-slash-commands --setting-sources ""
  --no-session-persistence --max-budget-usd <limite>
  [--json-schema <schema do resultado>]
  < handoff via stdin
```

O prompt vai por stdin porque `--tools <tools...>` é variádico e engole um prompt posicional. Isso aconteceu no teste: a primeira sonda falhou por esse motivo.

## 4. Roteamento e formato de handoff

**Regras de roteamento** (avaliadas em ordem):

1. **Papel → agentes habilitados com aquele `role`.** Se houver vários, vai para o menos ocupado e depois por rodízio.
2. **Delegável para externo** (padrão: `docs`, `tester` para gerar casos, resumos, boilerplate): vai para o provedor externo se houver um card dele, senão cai no Haiku.
3. **Nunca delegar para externo:** tarefas marcadas `sensitive` pelo planner (segredos, auth, dados), ou quando o workspace estiver marcado "só Claude".
4. **Escalonamento:** o Codificador devolve `blocked`, ou falha `maxReviewLoops` vezes. Então o Opus recebe o handoff original, o último resultado e o erro resumido. Não recebe o log inteiro.
5. **Conflito de arquivos:** handoffs com `files` em comum rodam em sequência. Se não houver arquivos em comum, rodam em paralelo, opcionalmente em worktrees separadas.
6. **Fallback de provedor:** se `detect()` falhar ou o provedor der erro de cota, a tarefa vai para o próximo agente do mesmo papel e o evento é registrado.

**Handoff Opus → executor** (validado por `--json-schema` na saída do Planejador e por zod no backend):

```json
{
  "task_id": "T2",
  "role": "coder",
  "goal": "Adicionar flag --dry-run ao comando sync",
  "files": ["src/cli/sync.ts", "src/cli/sync.test.ts"],
  "context": "sync() já recebe Options; siga o padrão de --verbose em src/cli/sync.ts",
  "interfaces": "Options.dryRun?: boolean; com dryRun, sync() não escreve e retorna a lista de ações",
  "steps": ["Adicionar a opção ao parser", "Curto-circuitar writeAll()", "Teste do caso dryRun"],
  "acceptance": ["npm test -- sync.test.ts passa", "sem mudança fora de files"],
  "constraints": ["não adicionar dependências"],
  "sensitive": false
}
```

Regras do formato, explicadas ao Planejador no system prompt:

- Use **caminhos, não conteúdo.** O executor tem `Read` e lê só o que precisa.
- **Sem histórico de conversa** e sem justificativa do plano. Só o que o executor precisa para agir.
- Mire em menos de 400 tokens por handoff. O backend mede e mostra o tamanho na UI. Acima de 800, emite um aviso.
- `acceptance` precisa ser verificável por comando. É o que o Revisor e o Testes executam.

**Resultado executor → orquestrador** (também com `--json-schema`):

```json
{
  "task_id": "T2",
  "status": "done",
  "summary": "Flag adicionada; writeAll pulado em dryRun; 1 teste novo.",
  "files_changed": ["src/cli/sync.ts", "src/cli/sync.test.ts"],
  "checks": [{ "cmd": "npm test -- sync.test.ts", "ok": true }],
  "questions": []
}
```

`status` vale `done`, `blocked` ou `failed`. O `summary` tem no máximo 5 linhas. Se o Opus precisar do diff, ele pede (`git diff -- <arquivo>`). O diff nunca vai automaticamente.

## 5. MCPs pré-definidos

Muitas das interações comuns já são ferramentas embutidas do Claude Code (`Read`, `Edit`, `Bash`). Para os agentes Claude, então, uma parte dos "presets" é só uma **allowlist de ferramentas**. MCP de verdade entra só quando agrega algo. Cada MCP adiciona o esquema das suas ferramentas a **toda** chamada do agente. Por isso o preset guarda `schemaTokens`, medido uma vez numa chamada enxuta com e sem o MCP, e o card mostra esse custo.

| Preset | Tipo | Para quem | Observação |
|---|---|---|---|
| **orq** (próprio) | MCP stdio | Planejador | `delegate_task(role, handoff)`, `task_status(id)`, `list_agents()`, `notes_read/notes_write` (bloco de notas compartilhado do Run, para fatos que vários agentes precisam sem reenviar contexto) |
| **Leitura/edição** | allowlist | Codificador, Docs | `Read, Edit, Write, Grep, Glob` |
| **Testes** | allowlist | Testes, Revisor | `Bash(npm test*)`, `Bash(pytest*)` etc., configurável por workspace |
| **Git (leitura)** | allowlist | Revisor, Planejador | `Bash(git diff*)`, `Bash(git log*)`, `Bash(git status*)` |
| **GitHub** | MCP oficial | Planejador, Revisor | Token em variável de ambiente no backend |
| **Docs de bibliotecas** | MCP (ex.: Context7) | Codificador | Evita que o Haiku chute APIs |
| **Navegador** | MCP Playwright | Testes | Só para projetos web; caro em schema, desligado por padrão |
| **Fetch/web** | allowlist `WebFetch` | Docs, Planejador | — |

O backend gera um arquivo `--mcp-config` por agente e usa `--strict-mcp-config`. Assim **não mexe** na sua configuração global (`claude mcp add` não é usado). Para agentes `dsh`, o suporte a MCP existe (`dsh-mcp-client`), mas o formato de configuração ainda é pergunta em aberto.

## 6. Medição de tokens e economia

**Coleta:**

- **Claude:** lê `modelUsage` e `total_cost_usd` do evento final (formato já confirmado). Com stream-json, a fase 0 confirma se o evento `result` traz os mesmos campos.
- **DeepSeek (`dsh`):** os pacotes têm `dsh-token-meter` e campos `inputTokens`/`outputTokens`, mas o formato dos eventos `--json` precisa ser confirmado na fase 0. Se não vier uso, o adapter estima por contagem de caracteres e marca `source: "estimado"`.
- Os tokens ficam separados por tipo (input, output, cache read, cache create), porque o preço de cada um é bem diferente.

**Bench** (`bench/`):

- Use um repositório-fixture pequeno com 5 tarefas e critérios de aceite executáveis. Exemplos: adicionar uma flag de CLI, corrigir um bug com teste falhando, refatorar uma função, escrever uma seção de README, criar testes para um módulo.
- Cada tarefa roda em **três modos**, cada um numa cópia limpa do fixture:
  1. `baseline-opus`: um único `claude -p --model opus` padrão, que é como você trabalha hoje.
  2. `baseline-opus-lean`: o mesmo, mas com os flags enxutos. Este modo separa quanto da economia vem do contexto enxuto e quanto vem da orquestração.
  3. `orchestrated`: o pipeline completo.
- Cada combinação roda 3 vezes, porque a variância é alta.
- **Só conta economia de execução que passou nos critérios de aceite.** Uma execução barata que falhou entra no relatório como falha.

**Relatório** (na página "Economia" e em `bench/report.md`):

- Tokens por modelo e custo pela tabela de lista, com média e faixa.
- **Tokens de Opus** em destaque, porque é a cota mais escassa no plano Pro.
- Tempo total e taxa de sucesso.
- Economia relativa: `orchestrated` contra cada baseline.

`costUSD` vem com `costBasis: "list"`. É o preço de API equivalente, não o que o plano Pro cobra. Ele serve de proxy para comparar modos, não de conta.

## 7. Fases e critério de "pronto"

| Fase | Entrega | Pronto quando |
|---|---|---|
| **0. Sondagem** | Script `detect` + fixtures de saída gravadas | Formato de eventos `stream-json` documentado (incluindo se exige `--verbose`), evento final com `modelUsage` confirmado, `opus` resolvendo para `claude-opus-5-5`, eventos `dsh --json` gravados, método de autenticação do `dsh headless` confirmado |
| **1. Núcleo + adapter Claude** | Backend, SQLite, `claude-cli` adapter, WebSocket | `POST /tasks` roda um agente; eventos aparecem no WS; `Usage` salvo bate com `modelUsage`; cancelar mata o processo |
| **2. UI** | Grade de cards (+), seletores de modelo/tipo/MCP, painel de atividade | Criar 3 cards, rodar um prompt e ver saída, tarefa atual e tokens por card ao vivo; config persiste ao reiniciar |
| **3. Orquestração** | Planejador com `--json-schema`, roteador, revisor, escalonamento | Uma tarefa do bench vai do pedido ao "pronto" com handoffs visíveis e tamanho de cada handoff exibido; teste forçado de `blocked` escala para o Opus |
| **4. MCP `orq` + presets** | Servidor MCP, geração de `--mcp-config`, medição de `schemaTokens` | Opus em modo agente chama `delegate_task` e recebe só o resumo; `claude mcp list` do usuário continua igual |
| **5. Adapter `dsh`** | `dsh-headless` adapter | Card "Docs/DeepSeek" executa tarefa real; adapter entrou sem alterar arquivos do núcleo (teste de contrato com fixtures) |
| **6. Bench** | `bench/` + página Economia | 5 tarefas × 3 modos × 3 repetições rodadas; relatório gerado |
| **7. Empacotamento** | `bin`, README, página Diagnóstico | Em um clone limpo: `npm i && npm start` abre a UI; Diagnóstico mostra versão, login e capacidades detectadas |

## 8. Riscos e limitações

- **`--bare` não serve com assinatura.** A economia de contexto depende da combinação de flags enxutos (seção 0). Ela desliga CLAUDE.md, hooks, plugins e skills, como caveman e ponytail. Por isso existe `inheritUserConfig` por card.
- **`--setting-sources ""` também ignora as regras de permissão do `settings.json`.** As permissões precisam ir explícitas (`--allowed-tools`, `--permission-mode`). Não usar `bypassPermissions` como padrão.
- **Sem aprovação interativa no `-p`.** A ajuda cita "the SDK host or --permission-prompt-tool", mas `--permission-prompt-tool` **não aparece** na lista de flags. Aprovação pela UI fica fora até ser verificada. Até lá, só allowlist.
- **Cota do Pro é opaca.** `total_cost_usd` é preço de lista. O limite real do plano não é exposto pela CLI, e vários agentes em paralelo gastam a mesma cota ao mesmo tempo. O app pode medir o consumo, mas não consegue prever o bloqueio.
- **Custo de cache:** cada processo novo com system prompt diferente paga `cache_creation`, que é mais caro que input comum. Templates de papel estáveis aumentam o `cache_read` entre tarefas do mesmo papel.
- **A qualidade do Haiku depende da spec.** Um loop revisor↔codificador pode comer a economia, por isso existe o teto `maxReviewLoops`.
- **Edição concorrente:** dois agentes no mesmo repositório podem colidir. A mitigação é a regra de conflito de arquivos e as worktrees (`-w`).
- **A CLI muda rápido** (de 2.1.301 para 2.1.306 hoje). O parser deve ignorar campos desconhecidos, e os testes de contrato usam fixtures gravadas. O Diagnóstico avisa quando um flag esperado some da `--help`.
- **`dsh` é release candidate (`0.2.1-rc.2`).** O formato de eventos `--json` não tem documentação pública. O adapter deve ser tolerante e isolado.
- **Termos de uso:** automatizar o Claude Code com a sua assinatura é para uso pessoal e local. Se outras pessoas usarem o app, cada uma usa o próprio login. Nada de servir terceiros com a sua conta.

## 9. Perguntas em aberto (dependem de você)

1. **Autenticação do DeepSeek:** você entra no `dsh web` com conta DeepSeek ou com chave de API? O `dsh headless` usa as mesmas credenciais? Posso rodar uma sonda mínima (`dsh --profile headless --json "ok"`) para gravar o formato dos eventos e ver se traz uso de tokens?
2. **Modelo e preço do DeepSeek:** qual modelo usar (o padrão é `deepseek-flash`)? Qual tabela de preço vale para o seu acesso, para o cálculo de economia? Quer também um adapter HTTP direto para a API DeepSeek (exige chave em variável de ambiente)?
3. **Métrica principal:** prioridade é poupar **tokens de Opus** (cota) ou o **custo total equivalente**?
4. **Permissões dos agentes:** sem perguntar, eles podem editar arquivos do workspace, rodar testes e fazer `git commit`? Algo deve ser proibido sempre?
5. **Workspaces:** um repositório por vez ou vários? Pode usar worktrees git por tarefa?
6. **Configuração do usuário:** os agentes devem herdar seus plugins e CLAUDE.md, ou começar enxutos por padrão (a recomendação)?
7. **Modo padrão:** pipeline conduzido pelo backend (a recomendação) ou o Opus delegando via MCP?
8. **Bench:** usar um fixture sintético ou tarefas de um projeto seu real?
9. **Público:** só você ou outras pessoas também? Isso muda empacotamento e termos de uso.
10. **Sonnet:** incluir o Sonnet como opção nos cards (a CLI aceita), ou ficar só com Opus e Haiku?
