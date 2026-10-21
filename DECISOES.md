# Decisões

Registro de fatos verificados e desvios em relação ao PLANO.md. Cada fixture citado fica em `fixtures/`.

## Respostas da seção 9 do PLANO.md

1. **DeepSeek:** login com conta Google pelo `dsh web`, sem chave de API. O resultado do modo headless está na fase 0 e na fase 5.
2. **Modelo DeepSeek padrão:** `deepseek-flash`. Quando não há preço, a UI mostra "sem preço". O adapter HTTP direto ficou fora do escopo.
3. **Métrica principal:** tokens de Opus. O custo de lista é secundário.
4. **Permissões:**
   - Permitido sem perguntar: ler e editar o workspace, rodar os comandos de teste e `git diff`, `git status` e `git log`.
   - Proibido sempre: `git commit`, `git push`, `rm` recursivo, `.env` e segredos, e `bypassPermissions`.
5. **Um workspace por vez.** As tarefas rodam em sequência; o paralelo fica atrás de uma opção desligada.
6. **Agentes enxutos por padrão** (`inheritUserConfig: false`), com um toggle por card.
7. **Modo padrão:** pipeline. O modo agente (MCP `orq`) é opcional.
8. **Sem bench e sem página "Economia".** A coleta de tokens por agente continua.
9. **Uso pessoal.** A instalação é `npm i && npm start`, sem publicação no npm.
10. **Sonnet** entra no seletor de modelo, sem papel padrão.

## Fase 0: sondagem (21/10/2026)

### Claude Code 2.1.306

- **Com `-p`, `--output-format stream-json` exige `--verbose`.** Sem ele, a CLI sai com `Error: When using --print, --output-format=stream-json requires --verbose` (`fixtures/claude/stream-json-requires-verbose.err`). Por isso o adapter sempre passa `--verbose`.
- **Eventos do stream** (`fixtures/claude/stream-tool.ndjson`), na ordem em que aparecem:
  - `system/init`: traz `model`, `tools` e `permissionMode`.
  - `assistant`: o conteúdo pode ser `thinking`, `tool_use` ou `text`.
  - `rate_limit_event`.
  - `user`: traz o `tool_result`.
  - `result`: traz `usage`, `modelUsage`, `total_cost_usd`, `structured_output` e `is_error`.
- **O `result` do stream traz o mesmo `modelUsage` do modo `json`.** A coleta de tokens lê só esse evento.
- **O alias `opus` resolve para `claude-opus-5-5`** (`modelUsage`, em `fixtures/claude/opus-schema.json`). O alias `haiku` resolve para `claude-haiku-5-5`.
- **Com `--json-schema`, o resultado validado vem em `structured_output`**, e `result` repete o mesmo conteúdo como texto JSON. A chamada usa 2 turnos (`num_turns: 2`).
- **Desvio do plano: a cota não é tão opaca quanto a seção 8 dizia.** O `rate_limit_event` traz `rate_limit_info.unifiedWindows.five_hour.utilization` e `seven_day.utilization`, cada um com `resetsAt`. O app mostra esses valores no topo da UI. O limite absoluto da cota continua desconhecido; a CLI só informa o percentual de uso.
- **`--permission-mode dontAsk` com `--allowed-tools` funciona em `-p`.** Uma ferramenta liberada roda sem perguntar. O que não estiver liberado é negado e aparece em `permission_denials`.

### DeepSeek Harness 0.2.1-rc.2

- **Formato dos eventos de `dsh --profile headless --json`** (NDJSON):
  - `{"type":"session","sessionId","cwd"}`
  - `{"type":"status","phase":"turn_start|step_start|step_end|turn_end", ...}`. No `turn_end`, `reason.kind` vale `error` e traz `error.code`/`error.message` quando a chamada falha.
  - `{"type":"final","text"}`
  - O código de saída é `1` quando há erro.
- **O perfil headless usa por padrão a rota `deepseek-official`, que exige `DEEPSEEK_API_KEY`.** Sem a chave, falha com `MISSING_CREDENTIAL` (`fixtures/dsh/missing-credential.ndjson`).
- **O perfil `web` usa `provider: deepseek-account`.** O headless já carrega os mesmos plugins de conta (`deepseek-account`, `llm-deepseek-account`, `credentials`), e as credenciais ficam no mesmo arquivo, `$DSH_HOME/.credentials.yaml`. Por isso o app passa um overlay próprio, `--patch` (gerado por execução pelo adapter `server/adapters/dsh.ts`, com o modelo do card), que troca o provider para `deepseek-account`. O seu perfil fica intocado.
- **Mesmo com o overlay, o headless respondeu `ACCOUNT_SIGN_IN_REQUIRED`** (`fixtures/dsh/account-sign-in-required.ndjson`). No código, `resolveToken` devolve `undefined` em três casos: quando não existe o registro `deepseek-account-platform/default` no arquivo de credenciais, quando o destino difere de `inferenceOrigin` ou quando o issuer é `localhost`. O arquivo de credenciais não foi lido, por decisão sua. Também não foi criada chave de API.
- **Consequência:** o adapter `dsh` segue o formato observado, e o Diagnóstico mostra "não autenticado" quando recebe um desses dois códigos de erro. Quando o login da conta passar a ser gravado para o headless, o mesmo adapter funciona sem mudança.
- **Uso de tokens do dsh: não observado.** Nenhuma chamada chegou ao modelo. O adapter aceita qualquer evento que tenha `inputTokens`/`outputTokens` (nomes encontrados no pacote `dsh-token-meter`). Se nada chegar, o adapter estima por caracteres e marca `source: "estimado"`.

## Implementação

- **HTTP com `node:http` + `ws`, sem Fastify.** São poucas rotas e um WebSocket, então um framework não compensaria a dependência a mais.
- **TypeScript roda direto no Node 24** (type stripping nativo), sem `tsx` nem etapa de build no servidor. Só a UI tem build, com Vite.
- **Testes com `node --test`.** Um binário falso do `claude` (`test/fake-claude.mjs`) reproduz as fixtures, então os testes não gastam tokens. Os testes que chamam modelos de verdade só rodam com `LIVE=1`.
- **Paralelismo (decisão 5): a opção `parallel` vem desligada.** Quando ligada, handoffs sem arquivos em comum rodam ao mesmo tempo no mesmo workspace. O isolamento por worktree ficou fora. Juntar o resultado de uma worktree de volta exigiria commit, e commit é proibido aos agentes (decisão 4).
- **Escalonamento:** quando o codificador devolve `blocked` ou estoura `maxReviewLoops`, o handoff vai para o agente Planejador (Opus). Ele roda com o template e as ferramentas de codificador, e o contexto enviado é só o handoff original, o último resumo e a nota do revisor.
- **Permissões padrão (decisão 4):** sempre `--permission-mode dontAsk` com allowlist explícita. As negações fixas, que valem para todo agente, são:
  - `Bash(git commit)`, `Bash(git commit *)`, `Bash(git push)`, `Bash(git push *)`
  - `Bash(rm -r *)`, `Bash(rm -rf *)`, `Bash(rm -fr *)`, `Bash(rm -R *)`
  - `Read(**/.env*)`, `Edit(**/.env*)`, `Read(**/*.pem)`, `Read(**/*.key)`
  - Verificado ao vivo (`test/live.test.ts`): `npm test` roda; a leitura de `.env` e o `git commit` são negados. Cada regra vai num argumento separado do argv, porque contém espaços.
  - `bypassPermissions` é rejeitado na validação do card.

## Fase 3: orquestração

- **`--json-schema` recusa o `$schema` que o zod gera.** O erro é `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. Os esquemas são enviados sem essa chave.
- **Os agentes recebem no system prompt a lista dos comandos de shell permitidos** (os de teste e o git de leitura). No primeiro run real, o planner escreveu aceites como `cd … && node -e …`, e a allowlist negou todos. Com isso, o codificador devolveu `blocked` e a tarefa escalou sem necessidade. Depois da mudança, o mesmo pedido passou de primeira.
- **Run real de referência**, com o pedido `slugify` + testes em `test/live.test.ts` (Opus planeja, Haiku codifica, Haiku revisa):

  | | Valor |
  |---|---|
  | Opus | 17,8k tokens, 1,2k de saída |
  | Total | 104k tokens, a maior parte em `cache_read` |
  | Handoffs | entre 247 e 414 tokens cada |
  | Custo de lista | US$ 0,044 |

  O `npm test` passou no workspace e nenhum commit foi feito.
- **Um revisor que falha (o processo, não a revisão) não trava o pipeline.** O resultado do executor é aceito, com a nota "revisor indisponível".
- **Provedor desconhecido conta como externo.** Por isso, ele nunca recebe handoffs `sensitive`.

## Fase 4: MCP `orq` e presets

- **O `orq` é um servidor MCP stdio** (`mcp/orq.ts`) com as ferramentas `delegate_task`, `task_status`, `list_agents`, `notes_read` e `notes_write`. Cada uma só repassa a chamada ao backend (`/api/orq/<run>/…`, com o token), e o roteamento continua no backend.
- **A config MCP é gerada por tarefa** em `data/mcp/<task>.json`, com modo `0600`, e é apagada no fim da tarefa. Sempre vai junto com `--strict-mcp-config`. O app nunca chama `claude mcp add`, e um teste garante isso.
- **`MCP_TOOL_TIMEOUT`** é passado ao `claude` quando há MCP, porque o `delegate_task` bloqueia enquanto o sub-pipeline roda. A variável não aparece na `--help`, então não foi verificada; se for ignorada, não causa efeito nenhum. No run real, uma delegação de cerca de 25 s não estourou.
- **Run real em modo agente** (o pedido `clamp`): o Opus chamou `mcp__orq__delegate_task` e recebeu só o resultado compacto. O Opus gastou 40,2k tokens, contra 17,8k no pipeline com um pedido de porte parecido, porque cada ida e volta de ferramenta reenvia o contexto do Opus. Isso confirma o pipeline como modo padrão (decisão 7).
- **Medição de presets:** duas chamadas enxutas no Haiku, com e sem o preset. A allowlist `web-fetch` mediu 789 tokens por chamada. O preset `github` só aparece como disponível quando `GITHUB_TOKEN` existe no ambiente do backend.

## Fase 5: adapter `dsh`

- **O adapter entrou sem alterar o núcleo.** O commit da fase 5 adiciona apenas `server/adapters/dsh.ts` e testes, e o carregador lê automaticamente qualquer `*.ts` em `server/adapters/`. Há um teste de contrato para todos os adapters.
- **O headless não tem flag de system prompt.** O template do papel vai na frente da tarefa, no stdin (`dsh ... --json -`). O modelo do card vai num overlay `--patch` temporário, que usa o provider `deepseek-account`.
- **Detecção real (21/10):** a versão é `0.2.1-rc.2`, e a autenticação aparece como **"não autenticado"** (`ACCOUNT_SIGN_IN_REQUIRED`). O card "Docs (DeepSeek)" recebe o handoff, falha e o pipeline cai no codificador Claude. Isso está coberto por teste.
- **Uso de tokens do DeepSeek:** sem evento de uso observado, o adapter estima por caracteres (`source: "estimado"`, `costUsd: null`, que aparece na UI como "sem preço").
- **Limitação de permissões:** o `dsh` usa o próprio sandbox (`DSH_PERMISSION_MODE`, padrão `workspace-write`, com raiz no cwd) e ignora a allowlist do app. Duas mitigações cobrem isso:
  - O roteamento nunca manda handoffs `sensitive` a provedores externos.
  - O adapter compara o `HEAD` do git antes e depois da execução. Se o agente fizer um commit, a tarefa termina em erro `COMMIT_FORBIDDEN`. O app não desfaz o commit; essa decisão fica com você.

  A leitura de `.env` pelo `dsh` **não** é bloqueada.
- **Os testes nunca chamam o `dsh` real.** `test/helpers.ts` aponta `DSH_BIN` para `test/fake-dsh.mjs`.

## Correção: DeepSeek autenticado pelo login do `dsh web`

- **Causa real:** o perfil headless vem com `deepseek-account`, `credentials` e `authorization` em `disabled: true`, e o plugin de conta depende dos outros dois. O overlay gerado pelo adapter agora religa os três (`disabled: false`). Com isso, o headless usa o mesmo login Google feito no `dsh web`, sem chave de API. Isso substitui a conclusão "não autenticado" da fase 5.
- **O uso de tokens é real.** Ele chega em `{"type":"status","phase":"step_end","usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}`, e o texto chega em `{"type":"text"}` (`fixtures/dsh/ok-account.ndjson`). Um "ok" custou 5.751 tokens de entrada no DeepSeek, que é o contexto base do próprio dsh.
