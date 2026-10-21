import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { snapshotTree } from './proc.ts';
import type { Store } from './db.ts';
import { commandsNote, roleRules, TEMPLATES } from './roles.ts';
import { estimateTokens } from './handoff.ts';
import { join } from 'node:path';
import { resolveMcps, writeMcpConfig, type McpServerSpec } from './mcps.ts';
import { listSkills, skillsPrompt } from './skills.ts';
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
  extraServers?: Record<string, McpServerSpec>;
  category?: string | null;
};

export type ExecResult = { taskId: string; text: string; structured: unknown; ok: boolean; error?: string; code?: string; usage: Usage[] };

export const newId = () => randomUUID().slice(0, 8);

export class Engine {
  store: Store;
  adapters: Map<string, Adapter>;
  running = new Map<string, AbortController>();
  lastRateLimit: unknown = null;

  dataDir: string;

  constructor(store: Store, adapters: Map<string, Adapter>, dataDir: string) {
    this.store = store;
    this.adapters = adapters;
    this.dataDir = dataDir;
  }

  workspace(): string {
    const ws = this.store.settings().workspace;
    const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
    if (!ws) throw bad('Configure o workspace antes de rodar tarefas.');
    if (!statSync(ws, { throwIfNoEntry: false })?.isDirectory()) throw bad(`Workspace não existe ou não é um diretório: ${ws}`);
    return ws;
  }

  /** Run one agent on one prompt. Emits started → (delta|tool_use|usage|…)* → exactly one of result|error. */
  async execute(o: ExecOpts): Promise<ExecResult> {
    const { store } = this;
    const role = o.role ?? o.agent.role;
    const taskId = newId();
    const base = { runId: o.runId, taskId, agentId: o.agent.id };
    const ctrl = new AbortController();
    store.createTask({ id: taskId, runId: o.runId, parentId: o.parentId ?? null, role, agentId: o.agent.id, input: o.prompt, category: o.category });
    this.running.set(taskId, ctrl);
    store.emit({ ...base, kind: 'started', payload: { role, model: o.agent.model, provider: o.agent.provider, inputTokens: estimateTokens(o.prompt) } });

    const usage: Usage[] = [];
    let text = '';
    let structured: unknown;
    let error: string | undefined;
    let code: string | undefined;
    let cfg: { path: string; remove: () => void } | null = null;
    try {
      const adapter = this.adapters.get(o.agent.provider);
      if (!adapter) throw new Error(`Provedor desconhecido: ${o.agent.provider}`);
      const settings = store.settings();
      store.setSnapshot(taskId, 'before', await snapshotTree(this.workspace()));
      const mcp = resolveMcps(o.agent.mcps, o.extraServers);
      if (mcp.missing.length) store.emit({ ...base, kind: 'status', payload: { kind: 'status', text: `MCP indisponível (variável de ambiente ausente): ${mcp.missing.join(', ')}` } });
      if (Object.keys(mcp.servers).length) cfg = writeMcpConfig(join(this.dataDir, 'mcp'), taskId, mcp.servers);
      const rules = [...(o.agent.tools ?? roleRules(role, settings.testCommands)), ...mcp.rules, ...(o.extraRules ?? [])];
      for await (const ev of adapter.run({
        agent: o.agent,
        prompt: o.prompt,
        systemPrompt:
          (o.systemPrompt ?? o.agent.systemPrompt ?? TEMPLATES[role]) +
          commandsNote(settings.testCommands) +
          skillsPrompt(o.agent.skills ?? settings.skills, listSkills(settings.workspace)),
        rules,
        cwd: this.workspace(),
        schema: adapter.supportsSchema ? o.schema : undefined,
        mcpConfigPath: cfg?.path,
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
      cfg?.remove();
      // Per-task diff for the trace view (before/after trees); never fatal.
      try {
        store.setSnapshot(taskId, 'after', await snapshotTree(this.workspace()));
      } catch {}
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

  private detected: Promise<any[]> | null = null;
  private detectedAt = 0;
  private detectedFor = 0;
  /** Detection is cached for 5 min: it may spawn a CLI (and for dsh, a tiny model call). */
  diagnostics(refresh = false) {
    if (refresh || !this.detected || Date.now() - this.detectedAt > 300_000 || this.detectedFor !== this.adapters.size) {
      this.detectedAt = Date.now();
      this.detectedFor = this.adapters.size;
      this.detected = Promise.all(
        [...this.adapters.values()].map(async (a) => ({ id: a.id, label: a.label, ...(await a.detect().catch((e) => ({ ok: false, version: null, auth: 'desconhecido', detail: String(e), capabilities: {} }))) })),
      );
    }
    return this.detected;
  }

  cancel(taskId: string) {
    this.running.get(taskId)?.abort();
    return this.running.has(taskId);
  }
}
