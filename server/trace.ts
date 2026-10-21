// Run traceability: who did what, why (category/handoff), with which tools, what changed, and what it cost.
import type { Store } from './db.ts';
import type { Engine } from './engine.ts';
import { capture } from './proc.ts';
import { httpError, type Route } from './http.ts';

const tokensOf = (rows: any[]) => ({
  novos: rows.reduce((s, u) => s + u.input + u.cache_create, 0),
  reaproveitados: rows.reduce((s, u) => s + u.cache_read, 0),
  saida: rows.reduce((s, u) => s + u.output, 0),
  costUsd: rows.length && rows.every((u) => u.cost_usd != null) ? rows.reduce((s, u) => s + u.cost_usd, 0) : null,
});
const total = (t: { novos: number; reaproveitados: number; saida: number }) => t.novos + t.reaproveitados + t.saida;

function json(s: string | null) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** Short human target of a tool call: the file, command or pattern it touched. */
function target(input: any) {
  if (!input || typeof input !== 'object') return '';
  return String(input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.handoff?.goal ?? '').slice(0, 160);
}

export function buildTrace(store: Store, engine: Engine, runId: string) {
  const run: any = store.db.prepare('select * from runs where id=?').get(runId);
  if (!run) return null;
  const agents = new Map(store.agents().map((a) => [a.id, a]));
  const external = (agentId: string) => engine.adapters.get(agents.get(agentId)?.provider ?? '')?.external ?? true;
  const tasks = (store.db.prepare('select * from tasks where run_id=? order by started_at').all(runId) as any[]).map((t) => {
    const usage = store.db.prepare('select * from usage where task_id=?').all(t.id) as any[];
    const tools = (store.db.prepare(`select payload from events where task_id=? and kind='tool_use' order by id`).all(t.id) as any[]).map((e) => {
      const p = json(e.payload);
      return { name: p?.name ?? '?', target: target(p?.input) };
    });
    const result = json(t.result);
    const handoff = json(t.input);
    const agent = agents.get(t.agent_id);
    return {
      id: t.id,
      role: t.role,
      category: t.category ?? handoff?.category ?? handoff?.handoff?.category ?? null,
      agent: agent ? { id: agent.id, name: agent.name, model: agent.model, provider: agent.provider } : { id: t.agent_id, name: '(removido)', model: '', provider: '' },
      external: external(t.agent_id),
      status: t.status,
      durationMs: t.ended_at ? t.ended_at - t.started_at : null,
      input: t.input?.slice(0, 4000) ?? '',
      summary: result?.structured?.summary ?? result?.error ?? (typeof result?.text === 'string' ? result.text.slice(0, 600) : ''),
      filesChanged: result?.structured?.files_changed ?? [],
      tools,
      tokens: tokensOf(usage),
      models: [...new Set(usage.map((u) => u.model))],
      hasDiff: Boolean(t.snap_before && t.snap_after && t.snap_before !== t.snap_after),
    };
  });
  const claude = tasks.filter((t) => !t.external);
  const outside = tasks.filter((t) => t.external);
  const sum = (ts: typeof tasks) => ts.reduce((s, t) => s + total(t.tokens), 0);
  const opus = tasks.filter((t) => t.models.some((m) => /opus/.test(m))).reduce((s, t) => s + total(t.tokens), 0);
  const summary = json(run.summary);
  return {
    run: { id: run.id, prompt: run.prompt, mode: run.mode, status: run.status, startedAt: run.started_at, endedAt: run.ended_at, summary: summary?.summary ?? null },
    totals: {
      claudeTokens: sum(claude),
      outsideTokens: sum(outside), // tokens Claude did not have to process
      opusTokens: opus,
      quota: summary?.quota ?? null,
      costUsd: tasks.reduce((s, t) => s + (t.tokens.costUsd ?? 0), 0),
    },
    tasks,
  };
}

export function traceRoutes(store: Store, engine: Engine): Route[] {
  return [
    ['GET', /^\/api\/runs\/([\w-]+)\/trace$/, ({ params }) => buildTrace(store, engine, params[0]) ?? Promise.reject(httpError(404, 'run não encontrado'))],
    ['GET', /^\/api\/tasks\/([\w-]+)\/diff$/, async ({ params }) => {
      const t = store.task(params[0]);
      if (!t) throw httpError(404, 'tarefa não encontrada');
      if (!t.snap_before || !t.snap_after) return { diff: '', note: 'sem snapshot (workspace não é um repositório git?)' };
      const ws = engine.workspace();
      const d = await capture('git', ['-C', ws, 'diff', '--stat', '--patch', t.snap_before, t.snap_after], 30000);
      return { diff: d.out.slice(0, 300_000), note: d.out.length > 300_000 ? 'diff truncado' : '' };
    }],
  ];
}
