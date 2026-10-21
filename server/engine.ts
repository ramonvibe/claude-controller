import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Store } from './db.ts';
import { roleRules, TEMPLATES } from './roles.ts';
import { estimateTokens } from './handoff.ts';
import type { Adapter, Agent, Role, Usage } from './types.ts';

export type ExecOpts = {
  runId: string;
  parentId?: string | null;
  agent: Agent;
  role?: Role; // effective role; differs from agent.role on escalation
  prompt: string;
  systemPrompt?: string;
  schema?: object;
  extraRules?: string[];
  mcpConfigPath?: string;
};

export type ExecResult = { taskId: string; text: string; structured: unknown; ok: boolean; error?: string; code?: string; usage: Usage[] };

export const newId = () => randomUUID().slice(0, 8);

export class Engine {
  store: Store;
  adapters: Map<string, Adapter>;
  running = new Map<string, AbortController>();
  lastRateLimit: unknown = null;

  constructor(store: Store, adapters: Map<string, Adapter>) {
    this.store = store;
    this.adapters = adapters;
  }

  workspace(): string {
    const ws = this.store.settings().workspace;
    if (!ws) throw new Error('Configure o workspace antes de rodar tarefas.');
    if (!statSync(ws, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Workspace não é um diretório: ${ws}`);
    return ws;
  }

  /** Run one agent on one prompt. Emits started → (delta|tool_use|usage|…)* → exactly one of result|error. */
  async execute(o: ExecOpts): Promise<ExecResult> {
    const { store } = this;
    const role = o.role ?? o.agent.role;
    const taskId = newId();
    const base = { runId: o.runId, taskId, agentId: o.agent.id };
    const ctrl = new AbortController();
    store.createTask({ id: taskId, runId: o.runId, parentId: o.parentId ?? null, role, agentId: o.agent.id, input: o.prompt });
    this.running.set(taskId, ctrl);
    store.emit({ ...base, kind: 'started', payload: { role, model: o.agent.model, provider: o.agent.provider, inputTokens: estimateTokens(o.prompt) } });

    const usage: Usage[] = [];
    let text = '';
    let structured: unknown;
    let error: string | undefined;
    let code: string | undefined;
    try {
      const adapter = this.adapters.get(o.agent.provider);
      if (!adapter) throw new Error(`Provedor desconhecido: ${o.agent.provider}`);
      const settings = store.settings();
      const rules = [...(o.agent.tools ?? roleRules(role, settings.testCommands)), ...(o.extraRules ?? [])];
      for await (const ev of adapter.run({
        agent: o.agent,
        prompt: o.prompt,
        systemPrompt: o.systemPrompt ?? o.agent.systemPrompt ?? TEMPLATES[role],
        rules,
        cwd: this.workspace(),
        schema: adapter.supportsSchema ? o.schema : undefined,
        mcpConfigPath: o.mcpConfigPath,
        signal: ctrl.signal,
      })) {
        if (ev.kind === 'result') {
          text = ev.text;
          structured = ev.structured;
          if (ev.isError) error = ev.text || 'erro do provedor';
        } else if (ev.kind === 'error') {
          error = ev.message;
          code = ev.code;
        } else if (ev.kind === 'usage') {
          const { kind, ...u } = ev;
          usage.push(u);
          store.addUsage(taskId, o.runId, o.agent.id, u);
          store.emit({ ...base, kind: 'usage', payload: u });
        } else {
          if (ev.kind === 'rate_limit') this.lastRateLimit = ev.info;
          store.emit({ ...base, kind: ev.kind, payload: ev });
        }
      }
      if (!error && !text && structured === undefined) error = 'provedor terminou sem resultado';
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      this.running.delete(taskId);
    }

    if (error) {
      store.endTask(taskId, 'error', { error, code });
      store.emit({ ...base, kind: 'error', payload: { message: error, code } });
    } else {
      store.endTask(taskId, 'done', { text: text.slice(0, 4000), structured });
      store.emit({ ...base, kind: 'result', payload: { text: text.slice(0, 4000), structured } });
    }
    return { taskId, text, structured, ok: !error, error, code, usage };
  }

  cancel(taskId: string) {
    this.running.get(taskId)?.abort();
    return this.running.has(taskId);
  }
}
