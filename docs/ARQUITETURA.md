# Arquitetura

Documentação técnica para quem mexe no código. Uso do app está no [README](../README.md).
Decisões e fatos verificados ficam em [DECISOES.md](../DECISOES.md); a especificação original, em [PLANO.md](../PLANO.md).

## 1. Visão geral

O servidor é um processo Node que escuta em `127.0.0.1` e serve a UI e a API. Ele guarda estado em SQLite e
roda os agentes por adaptadores. Toda tarefa é um processo ou uma chamada HTTP externa.

Fluxo do pipeline (`server/orchestrator.ts`):

1. `Orchestrator.start` cria o run e chama o Planejador com `planSchema`.
2. `parseStructured` valida o JSON do plano. Plano inválido encerra o run com erro.
3. `route` escolhe os candidatos de cada handoff: rota por categoria, papel, filtro `sensitive`, externo primeiro em papéis delegáveis e coder como último recurso.
4. `execHandoff` manda o handoff em JSON ao executor. O executor roda com `resultSchema`.
5. `review` manda handoff e resumo ao Revisor. `done` encerra; `failed` volta a nota ao executor.
6. Se o executor devolve `blocked`/`failed` ou estoura `maxReviewLoops`, a tarefa escala para o Planejador rodando como coder.
7. Falha de provedor (não autenticado, crash) passa para o próximo candidato, mas só antes de qualquer revisão.
8. `finish` grava status, resumo, resultados, tokens de Opus e tokens totais, e emite `run_done`.

Tarefas rodam em sequência. Com `settings.parallel`, `disjointWaves` agrupa handoffs consecutivos sem arquivos em comum.

No modo `agent`, o Planejador recebe o MCP `orq` e delega com `delegate_task`. Cada delegação chama `Orchestrator.handle`,
ou seja, o mesmo caminho de roteamento, revisão e escalonamento do pipeline.

## 2. Mapa de módulos

| Arquivo | Papel |
|---|---|
| `server/index.ts` | Monta store, engine, adaptadores, rotas e token; escuta a porta. |
| `server/http.ts` | Servidor HTTP, rotas base, token, estáticos, WebSocket. |
| `server/types.ts` | Tipos compartilhados: `Agent`, `Settings`, `Adapter`, `AdapterEvent`, `BusEvent`. |
| `server/db.ts` | `Store` sobre `node:sqlite`; persistência, eventos e consultas. |
| `server/engine.ts` | `Engine.execute`: prepara prompt, regras, MCPs, roda o adaptador e grava o resultado. |
| `server/orchestrator.ts` | Pipeline, modo agente, roteamento, revisão, escalonamento e rotas de runs. |
| `server/handoff.ts` | Schemas zod de `Handoff`, `Plan` e `Result`; parsing e estimativa de tokens. |
| `server/roles.ts` | Templates de system prompt, allowlist por papel e lista `DENY`. |
| `server/agents.ts` | Validação de cards (`AgentInput`), defaults e seed inicial. |
| `server/mcps.ts` | Presets de MCP, resolução de regras e escrita do `--mcp-config` por tarefa. |
| `server/skills.ts` | Lê `SKILL.md` do Claude Code e monta o texto anexado ao system prompt. |
| `server/toolloop.ts` | Loop de ferramentas e sandbox para modelos de API compatíveis com OpenAI. |
| `server/proc.ts` | Spawn de CLI com stdin, NDJSON, timeout e abort. |
| `server/openai.ts` | Provedores via API: catálogo, chaves, modelos e adaptador dinâmico. |
| `server/connect.ts` | Login pelos próprios CLIs (`dsh web`, Gemini CLI) e instalação. |
| `server/catalog.ts` | Catálogo de provedores de API e tiers. |
| `server/adapters/index.ts` | Carrega todo adaptador da pasta. |
| `server/adapters/claude.ts` | CLI do Claude Code: argumentos, stream-json e detecção. |
| `server/adapters/dsh.ts` | DeepSeek Harness: perfil de conta, eventos e detecção. |
| `server/adapters/gemini.ts` | Gemini CLI: comando, eventos e detecção. |
| `mcp/orq.ts` | Servidor MCP `orq` via stdio; cada tool chama a API do backend. |
| `web/src/api.ts` | `fetch` com `x-token`, WebSocket com reconexão e formatadores. |
| `web/src/App.tsx` | Tela principal, snapshot, eventos e ações. |
| `web/src/Card.tsx` | Card de agente. `web/src/status.ts` reduz eventos ao estado dos cards. |
| `web/src/Activity.tsx` | Histórico de runs e detalhe. |
| `web/src/Providers.tsx` | Provedores via API. `web/src/Connectors.tsx`: logins e instalação. |
| `web/src/Diagnostics.tsx` | Diagnóstico dos CLIs e medição de MCPs. |
| `web/src/Routing.tsx` | Tabela de roteamento por categoria. `web/src/Skills.tsx`: skills padrão. |
| `web/src/main.tsx` | Monta o React. |

## 3. Interface de adapter e como adicionar um provedor

O contrato está em `server/types.ts`:

```ts
type Adapter = {
  id: string;
  label: string;
  external: boolean; // provedor não-Claude nunca recebe tarefa sensitive
  models: string[];
  supportsSchema: boolean;
  tier?: string;
  modelTiers?: Record<string, string>;
  detect(): Promise<Detect>;
  run(input: RunInput): AsyncIterable<AdapterEvent>;
};
```

`RunInput` traz `agent`, `prompt`, `systemPrompt`, `rules`, `cwd`, `schema`, `mcpConfigPath` e `signal`.
`run` devolve eventos: `status`, `delta`, `tool_use`, `rate_limit`, `usage`, `result`, `error`.
`Engine.execute` consome esses eventos, grava usage e emite no barramento.

`detect` devolve `ok`, `version`, `auth` (`ok`, `não autenticado` ou `desconhecido`), `detail` e `capabilities`.
O resultado fica em cache no `Engine` até `?refresh=1`.

Para adicionar um provedor:

1. Crie `server/adapters/<id>.ts` que default-exporta um `Adapter`. O `id` é a chave no mapa.
2. Implemente `detect` com `capture` de `server/proc.ts`, se for CLI, ou uma chamada leve, se for API.
3. Implemente `run` como gerador assíncrono. Use `ndjson` para CLIs e `toolLoop` para APIs compatíveis com OpenAI.
4. Marque `external: true` se o provedor não for o Claude Code. Isso bloqueia tarefas `sensitive`.
5. Rode `npm test`; não há registro manual: `loadAdapters` varre a pasta e ignora `index.ts` e `*.test.ts`.

Provedores via API não viram arquivo: `server/openai.ts` registra um adaptador em memória a partir de uma entrada do
catálogo e da chave no ambiente ou no `.env`. Use esse caminho quando o provedor fala `chat/completions`.

## 4. Formato do handoff e do plano

`Plan` é `{ summary, tasks: Handoff[] }` com pelo menos uma tarefa. `Handoff` tem:

| Campo | Tipo | Uso |
|---|---|---|
| `task_id` | string | Identificador devolvido no resultado. |
| `role` | `coder`, `tester` ou `docs` | Papel do executor. |
| `category` | `architecture`, `feature`, `small-change`, `tests`, `docs` | Escolhe a rota. |
| `goal` | string | O que fazer. |
| `files` | string[] | Arquivos que podem ser tocados. |
| `context` | string | Contexto autossuficiente. |
| `interfaces` | string | Nomes e assinaturas exatas. |
| `steps` | string[] | Ordem de execução. |
| `acceptance` | string[] | Critérios verificáveis por comando. |
| `constraints` | string[] | O que não fazer. |
| `sensitive` | boolean | Exclui provedores externos. |

`Result` é `{ task_id, status, summary, files_changed, checks, questions }`, com `status` em `done`, `blocked` ou `failed`.
O executor devolve só esse objeto; o Revisor devolve `done` ou `failed`.

Os schemas enviados ao CLI saem de `z.toJSONSchema` sem `$schema`. Provedores com `supportsSchema: false` recebem o schema
só no prompt: `parseStructured` tenta o objeto estruturado e depois extrai o primeiro bloco `{...}` do texto.
`estimateTokens` usa `length / 4`; é estimativa para exibição, não cobrança.

## 5. API HTTP e mensagens WebSocket

Todas as rotas `/api/` exigem o header `x-token`. Erros voltam como `{ "error": "..." }` com o status adequado.

Rotas definidas em `server/http.ts`:

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/state` | Snapshot: agentes, settings, provedores, tarefas vivas, usage e rate limit. |
| POST | `/api/agents` | Cria card. |
| PUT | `/api/agents/:id` | Atualiza card. |
| DELETE | `/api/agents/:id` | Remove card. |
| PUT | `/api/settings` | Salva workspace, comandos, modo, roteamento e skills. |
| POST | `/api/tasks` | Roda um card sozinho; devolve `runId`. |
| POST | `/api/tasks/:id/cancel` | Cancela a tarefa. |
| GET | `/api/runs` | Últimos runs. |
| GET | `/api/runs/:id` | Run com tarefas, eventos e usage. |
| GET | `/api/skills` | Skills disponíveis, sem o corpo. |
| GET | `/api/diagnostics` | Detecção dos adaptadores; `?refresh` ignora o cache. |
| GET | `/api/tasks/:id/events` | Eventos gravados da tarefa. |

Rotas registradas por `extraRoutes` (não estão em `server/http.ts`):

| Método | Rota | Uso |
|---|---|---|
| POST | `/api/runs` | Inicia run orquestrado (pipeline ou agente). |
| POST | `/api/runs/:id/cancel` | Cancela o run. |
| GET | `/api/mcps` | Presets, disponibilidade e custo em tokens. |
| POST | `/api/mcps/:id/measure` | Mede os tokens do preset com uma chamada Haiku. |
| POST | `/api/orq/:runId/delegate` | Delega um handoff; usado pelo MCP `orq`. |
| GET | `/api/orq/:runId/tasks/:taskId` | Resultado compacto da tarefa. |
| GET | `/api/orq/:runId/agents` | Agentes ativos para o planejador. |
| GET | `/api/orq/:runId/notes` | Notas compartilhadas do run. |
| POST | `/api/orq/:runId/notes` | Acrescenta nota. |
| GET | `/api/catalog` | Catálogo de provedores e se a chave existe. |
| GET | `/api/providers` | Provedores via API salvos. |
| POST | `/api/providers/models` | Busca modelos no provedor. |
| POST | `/api/providers` | Salva provedor. |
| PUT | `/api/providers/:id` | Atualiza provedor. |
| DELETE | `/api/providers/:id` | Remove provedor. |
| GET | `/api/connect` | Estado dos logins por CLI. |
| POST | `/api/connect/:id` | Abre o login do provedor. |
| POST | `/api/connect/:id/stop` | Cancela o login. |
| POST | `/api/connect/gemini-cli/install` | Instala a Gemini CLI. |

Níveis de delegação (`server/tiers.ts`): `GET /api/orq/:runId/tiers` lista os níveis ativos com `id`, `tool`, `role`, `category` e `hint` (o `when`). O servidor MCP `orq` cria uma ferramenta dinâmica por nível ativo, nomeada por `toolName(id)` (`-` vira `_`). Cada ferramenta fixa papel e categoria, e o corpo do handoff vem do planejador. No modo pipeline, o mesmo nível vai no campo `tier` do handoff. `POST /api/orq/:runId/delegate` aceita `tier` no corpo, que sobrescreve o do handoff.

WebSocket: `ws://<host>/ws?token=<token>`. O servidor recusa origem ou host diferente do loopback, ou token errado.
Cada mensagem é um `BusEvent`: `{ id, ts, runId, taskId, agentId, kind, payload }`.

| `kind` | Payload |
|---|---|
| `started` | Papel, modelo, provedor e tokens de entrada estimados. |
| `delta`, `status`, `tool_use`, `rate_limit` | Saída incremental do adaptador. |
| `usage` | Um `Usage`. |
| `result`, `error` | Fim da tarefa. |
| `handoff` | Handoff, papel, tokens estimados e motivo. |
| `run_started`, `run_done` | Início e fim do run. |
| `agents_changed` | Card criado, alterado ou removido. |
| `connect` | Andamento do login de um provedor. |

A UI reconecta sozinha e pede `/api/state` a cada abertura; o evento é incremental, não a fonte da verdade.

## 6. Banco SQLite

`Store` abre `<CC_DATA>/controller.db` e cria as tabelas:

| Tabela | Conteúdo |
|---|---|
| `agents` | `id`, `pos` e `data` (JSON do card). |
| `kv` | `settings` e `mcpTokens`. |
| `runs` | `prompt`, `mode`, `status`, `started_at`, `ended_at`, `summary`. |
| `tasks` | Run, pai, papel, agente, entrada, status, resultado e tempos. |
| `events` | Todo evento do barramento, com `payload` JSON. |
| `usage` | Tokens e custo por tarefa, run, agente e modelo. |
| `notes` | Notas por run. |
| `providers` | Provedores via API, `id` e `data` JSON. |

Na abertura, tarefas e runs com status `running` viram `error` com a marca `processo reiniciado`: o processo anterior morreu.
`liveState` devolve as tarefas em andamento e o último status por agente; é o que reconstrói as cores dos cards.
`usageTotals` agrega por agente e modelo e alimenta o painel de execuções.

## 7. Segurança

- **Token:** gerado a cada início (`randomBytes(24)`), comparado com `timingSafeEqual`. Chega à página por uma meta tag
  injetada no HTML; a UI o envia em `x-token`. O WebSocket o recebe na query.
- **Rede:** o servidor escuta só em `127.0.0.1`. Requisições com `Host` diferente de `127.0.0.1:<porta>` ou
  `localhost:<porta>` recebem 421, o que barra DNS rebinding. O upgrade do WebSocket também confere `Origin`.
- **Estáticos:** o caminho é normalizado e precisa continuar dentro de `dist`.
- **Corpo:** JSON limitado a 1 MB e validado com zod; corpo inválido devolve 400.
- **Cards:** `parseAgent` valida papel, limites, provider existente e demais campos antes de salvar.
- **Allowlist:** `roles.ts` define as regras por papel e a lista `DENY`, sempre negada: `git commit`, `git push`,
  `rm` recursivo e leitura/edição de `.env`, `*.pem` e `*.key`. Agentes Claude rodam com `--permission-mode dontAsk`.
- **Docs e testes:** `docs` só recebe `git diff`, `git status` e `git log` como comandos. `tester` recebe esses e os comandos de teste configurados.
- **Sensitive:** provedor com `external: true` é excluído de handoff `sensitive`. Provedor desconhecido conta como externo.
- **MCP:** a config é escrita por tarefa com modo `0600` e apagada no `finally`. A config global do Claude Code não muda.
- **toolloop:** modelos de API só recebem as ferramentas que as regras permitem. Todo caminho passa por `realpath` e precisa
  ficar dentro do workspace; segredos e escrita em `.git` são recusados. Comandos que casam com `META` são negados:
  separadores, pipe, substituição, redirecionamento, quebra de linha e barra invertida. Também são negados
  `git commit`, `git push` e `rm -r`. Só comandos da allowlist rodam, com timeout de 120 s.
