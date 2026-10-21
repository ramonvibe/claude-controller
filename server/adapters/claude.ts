import { ndjson, capture } from '../proc.ts';
import { DENY, toolNames } from '../roles.ts';
import type { Adapter, AdapterEvent, Detect, RunInput } from '../types.ts';

const BIN = process.env.CLAUDE_BIN ?? 'claude';

/** Flags the adapter relies on; Diagnóstico warns when one disappears from `claude --help`. */
export const REQUIRED_FLAGS = [
  '--print', '--output-format', '--verbose', '--model', '--effort', '--system-prompt', '--append-system-prompt',
  '--tools', '--allowed-tools', '--disallowed-tools', '--permission-mode', '--strict-mcp-config', '--mcp-config',
  '--disable-slash-commands', '--setting-sources', '--no-session-persistence', '--json-schema', '--max-budget-usd',
];

export function claudeArgs(i: RunInput): string[] {
  const { agent } = i;
  const a = ['-p', '--model', agent.model, '--output-format', 'stream-json', '--verbose'];
  if (agent.effort) a.push('--effort', agent.effort);
  if (agent.inheritUserConfig) a.push('--append-system-prompt', i.systemPrompt);
  else
    a.push('--system-prompt', i.systemPrompt, '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence');
  a.push('--tools', toolNames(i.rules).join(','));
  // One argv element per rule: rules like "Bash(npm test *)" contain spaces.
  if (i.rules.length) a.push('--allowed-tools', ...i.rules);
  a.push('--disallowed-tools', ...DENY, '--permission-mode', 'dontAsk');
  if (i.mcpConfigPath) a.push('--mcp-config', i.mcpConfigPath);
  if (i.schema) a.push('--json-schema', JSON.stringify(i.schema));
  if (agent.limits.maxBudgetUsd) a.push('--max-budget-usd', String(agent.limits.maxBudgetUsd));
  return a;
}

/** Map one stream-json object (format in fixtures/claude/stream-tool.ndjson) to adapter events. */
export function mapClaudeEvent(o: any): AdapterEvent[] {
  switch (o?.type) {
    case 'system':
      return o.subtype === 'init' ? [{ kind: 'status', text: `modelo ${o.model}` }] : [];
    case 'assistant': {
      const out: AdapterEvent[] = [];
      for (const c of o.message?.content ?? []) {
        if (c.type === 'text' && c.text) out.push({ kind: 'delta', text: c.text });
        else if (c.type === 'tool_use') out.push({ kind: 'tool_use', name: c.name, input: c.input });
      }
      return out;
    }
    case 'rate_limit_event':
      return [{ kind: 'rate_limit', info: o.rate_limit_info }];
    case 'result': {
      const out: AdapterEvent[] = Object.entries(o.modelUsage ?? {}).map(([model, u]: [string, any]) => ({
        kind: 'usage',
        model: u.canonicalModel ?? model,
        input: u.inputTokens ?? 0,
        output: u.outputTokens ?? 0,
        cacheRead: u.cacheReadInputTokens ?? 0,
        cacheCreate: u.cacheCreationInputTokens ?? 0,
        costUsd: u.costUSD ?? null,
        source: 'claude-json',
      }));
      const text = typeof o.result === 'string' ? o.result : (o.errors ?? []).join('\n') || o.subtype || '';
      out.push({ kind: 'result', text, structured: o.structured_output, isError: Boolean(o.is_error) || o.subtype !== 'success' });
      return out;
    }
    default:
      return [];
  }
}

const claude: Adapter = {
  id: 'claude-cli',
  label: 'Claude Code (local)',
  external: false,
  models: ['opus', 'sonnet', 'haiku'],
  supportsSchema: true,

  async detect(): Promise<Detect> {
    const v = await capture(BIN, ['--version']);
    if (v.code !== 0) return { ok: false, version: null, auth: 'desconhecido', detail: `claude não encontrado: ${v.err.trim()}`, capabilities: {} };
    const help = await capture(BIN, ['--help']);
    const capabilities = Object.fromEntries(REQUIRED_FLAGS.map((f) => [f, help.out.includes(f)]));
    const st = await capture(BIN, ['auth', 'status']);
    let auth: Detect['auth'] = 'desconhecido';
    let detail = '';
    try {
      const j = JSON.parse(st.out);
      auth = j.loggedIn ? 'ok' : 'não autenticado';
      detail = `${j.authMethod ?? ''} ${j.subscriptionType ?? ''}`.trim();
    } catch {
      detail = st.err.trim().slice(0, 200);
    }
    const missing = REQUIRED_FLAGS.filter((f) => !capabilities[f]);
    if (missing.length) detail += ` · flags ausentes: ${missing.join(' ')}`;
    return { ok: auth === 'ok' && !missing.length, version: v.out.trim(), auth, detail, capabilities };
  },

  async *run(i: RunInput) {
    let sawResult = false;
    for await (const item of ndjson(BIN, claudeArgs(i), {
      cwd: i.cwd,
      stdin: i.prompt,
      signal: i.signal,
      timeoutMs: i.agent.limits.timeoutSec * 1000,
    })) {
      if ('json' in item) {
        for (const ev of mapClaudeEvent(item.json)) {
          if (ev.kind === 'result') sawResult = true;
          yield ev;
        }
      } else if ('exit' in item && !sawResult) {
        const { code, stderr, aborted } = item.exit;
        yield { kind: 'error', message: aborted ? 'cancelado ou tempo esgotado' : stderr.trim().slice(-500) || `claude saiu com código ${code}` };
      }
    }
  },
};

export default claude;
