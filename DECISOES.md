# Decisões

Registro de fatos verificados e desvios em relação ao PLANO.md. Cada fixture citado fica em `fixtures/`.

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
- **O perfil `web` usa `provider: deepseek-account`.** O headless já carrega os mesmos plugins de conta (`deepseek-account`, `llm-deepseek-account`, `credentials`), e as credenciais ficam no mesmo arquivo, `$DSH_HOME/.credentials.yaml`. Por isso o app passa um overlay próprio, `--patch server/adapters/dsh/account.patch.yml`, que troca o provider para `deepseek-account`. O seu perfil fica intocado.
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
  - `Bash(git commit:*)`, `Bash(git push:*)`
  - `Bash(rm -r:*)`, `Bash(rm -rf:*)`, `Bash(rm -fr:*)`
  - `Read(**/.env*)`, `Read(**/*.pem)`, `Read(**/*.key)`
  - `bypassPermissions` é rejeitado na validação do card.
