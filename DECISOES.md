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

## Rodada 2: modelos substitutos para economizar o Claude

O objetivo, reafirmado por você: qualquer IA de terceiros, grátis ou paga, deve poder assumir as tarefas menores. O PC é fraco, então não há modelos locais.

- **Roteamento por categoria.** O Opus classifica cada handoff em `architecture`, `feature`, `small-change`, `tests` ou `docs`. A tabela "Quem faz cada tipo de tarefa" na UI define, por categoria, o card e o reserva. Os padrões são:

  | Categoria | Card padrão |
  |---|---|
  | `architecture` | Planejador (Opus) |
  | `feature` | Codificador (Haiku) |
  | `small-change` | Codificador (Haiku) |
  | `tests` | Codificador (Haiku) |
  | `docs` | DeepSeek, com o Haiku de reserva |

  Se a categoria não tem card definido, vale a regra antiga, pelo papel.
- **O esforço (effort) é configurado por card** para os modelos Claude.
- **Provedores via API compatível com OpenAI, adicionados à mão** (página Provedores). O catálogo mostra o tipo de cada um:
  - **(free):** Gemini API (AI Studio), Groq, Cerebras, Mistral e GitHub Models.
  - **(free/paga por modelo):** OpenRouter. Os modelos `:free` ou com preço 0 aparecem como free.
  - **(paga):** DeepSeek API, OpenAI, xAI e Together.
  - **Outro:** qualquer URL compatível com OpenAI.
- **As chaves ficam só no `.env` do backend** (no `.gitignore`). O arquivo é relido a cada chamada, e a chave nunca passa pelo navegador. A UI mostra apenas se a chave existe.
- **Loop de ferramentas (`server/toolloop.ts`).** O modelo recebe `read_file`, `list_files`, `search`, `write_file`, `edit_file` e `run_command`, conforme as regras do papel. As mesmas negações dos agentes Claude valem aqui:
  - fora do workspace, ou por symlink que aponte para fora;
  - `.env`, `*.pem` e `*.key`;
  - escrita em `.git`;
  - comandos fora da allowlist, ou com `; & | $ < >`;
  - `git commit`/`push` e `rm -r`.

  Um 429 é tentado de novo, até 3 vezes. Modelos do OpenRouter sem suporte a `tools` aparecem marcados como "não edita arquivos".
- **Conectar (login pelo navegador, com o login do próprio provedor):**
  - **DeepSeek:** sobe `dsh web --no-open`, abre a página de login numa aba e confere a cada 20 s até o headless conseguir responder.
  - **Gemini CLI:** usa `GOOGLE_GENAI_USE_GCA=true`, e a própria CLI abre o login do Google. O botão "Instalar" roda `npm i -g @google/gemini-cli@0.65.0`.
  - **Não verificado na Gemini CLI:** o login pelo botão e o formato de `-o stream-json`. Com `NO_BROWSER` (modo sem navegador), ela recusa o login em modo não interativo. O mapeamento de eventos segue a documentação da CLI e ainda precisa de uma fixture real.
- **Skills padrão:** o app lê as skills de `~/.claude/skills`, dos plugins (só a versão mais nova de cada) e de `.claude/skills` do workspace. O texto delas entra no prompt de qualquer provedor. As padrão são definidas nas Configurações, e cada card pode usar uma lista própria. A UI mostra o custo em tokens por chamada.
- **Run real no card DeepSeek** (`dsh`, conta grátis): o modelo escreveu um `README.md` pelo app e devolveu o resultado em JSON. O uso foi real (cerca de 6k tokens por passo, quase tudo `cache_read`) e o custo, US$ 0.

## Rodada 3: rastreabilidade, checagem antes de rodar, tela limpa e modos de economia

Princípio, nas suas palavras: o mais importante é o pedido ser entregue, então o Opus continua sempre planejando e arquitetando. Por isso não há teto de tokens por run nem triagem que pule o Opus.

- **Checagem antes de rodar (`GET /api/preflight`).** Antes de cada run, o app confere se o primeiro card de cada categoria, o Planejador e o Revisor estão conectados. Se algum não estiver, a UI pergunta: Conectar, "Usar X só desta vez" ou Cancelar. A escolha vai como `overrides` no `POST /api/runs`, e o card desconectado nem é tentado. A troca automática de provedor durante o run continua existindo, mas agora aparece na linha do tempo.
- **Chave colada na tela (`POST /api/keys`).** A chave é gravada uma vez no `.env` local (modo 0600) e nunca é devolvida. Isso relaxa, com o seu ok, a regra "a chave nunca passa pelo frontend": ela atravessa o navegador uma única vez, só localmente.
- **Linha do tempo por run (`GET /api/runs/:id/trace`).** Mostra, para cada tarefa:
  - papel, categoria, card e modelo;
  - se rodou fora do Claude;
  - duração;
  - o handoff recebido;
  - as ferramentas usadas, com o arquivo ou comando de cada uma;
  - os arquivos alterados;
  - os tokens em três números: novos (entrada + escrita de cache), reaproveitados (leitura de cache) e saída.
- **Diff por tarefa.** Antes e depois de cada tarefa, o app tira um snapshot da árvore de trabalho com um índice git descartável (`GIT_INDEX_FILE`, `add -A`, `write-tree`). O snapshot inclui arquivos não rastreados e respeita o `.gitignore`. O índice, o branch e os arquivos do usuário ficam intocados (há teste para isso). O diff fica em `GET /api/tasks/:id/diff`.
- **Cota por run.** É a utilização da janela de 5h antes do run (o último valor visto) e depois (o último `rate_limit_event` do run). O valor é aproximado: a granularidade é de 1%, e outras sessões suas também consomem a cota.
- **"Feito fora do Claude":** a porcentagem dos tokens do run que foram processados por outras IAs.
- **Tela limpa.** O Início mostra o pedido, os cards compactos (papel, modelo, tipo de preço, status e tokens), a linha do tempo e um bloco de primeiros passos. A edição completa do card fica num modal. Workspace, modo, roteamento, revisão, mapa e skills ficam em Configurar. O feed bruto de eventos foi removido.
- **Revisão por categoria.** O padrão é revisar todas as categorias menos docs.
- **Mapa do repositório.** Um card barato ou grátis, escolhido em Configurar, escreve um resumo do projeto de até cerca de 800 tokens. O Opus planeja lendo esse resumo e só abre arquivos onde ele não basta. O resumo fica em cache pelo snapshot exato da árvore, então é refeito só quando o código muda. Se o mapa falhar, o Opus segue lendo o código.

## Correção: o Conectar não abria o login

- **Gemini CLI:** no modo `-p`, antes do login a CLI pergunta no stdin "Opening authentication page in your browser. Do you want to continue? [Y/n]". O app lançava o processo com o stdin fechado, então o login ficava parado nessa pergunta. Agora o app responde `y` e passa `--skip-trust`. Sem esse flag, a CLI sai com código 55 em diretório não confiável.
- **Como a URL de login é capturada:** a Gemini CLI abre o login com o `xdg-open` do PATH. O app coloca na frente um `xdg-open` intermediário que grava a URL e repassa ao abridor real. Assim a página também mostra o link "Abrir página de login".
- **Sem `DISPLAY`:** a CLI exige a autorização manual, que não funciona sem terminal. Por isso o app precisa rodar numa sessão gráfica.
- **Verificado sem abrir navegador:** com um `xdg-open` falso, a CLI real chamou o abridor com `https://accounts.google.com/o/oauth2/v2/auth?...`. O login completo com o seu Google não foi testado.
- **DeepSeek (`dsh`):** a aba do login era aberta depois da resposta do servidor, fora do clique, e o Firefox bloqueava como popup. Agora a aba é aberta no próprio clique e redirecionada depois que a resposta chega. Também aparece o link de reserva.
