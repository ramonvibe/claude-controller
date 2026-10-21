import { z } from 'zod';
import { join } from 'node:path';
import type { Store } from './db.ts';
import { newId, type Engine, type ExecResult } from './engine.ts';
import { Plan, planSchema, resultSchema, parseStructured, toResult, estimateTokens, Handoff, type Result } from './handoff.ts';
import { AGENT_MODE_PLANNER, TEMPLATES } from './roles.ts';
import { orqServer, PRESETS, resolveMcps, writeMcpConfig } from './mcps.ts';
import claude from './adapters/claude.ts';
import type { Agent } from './types.ts';
import { httpError, type Route } from './http.ts';

/** Roles worth sending to an external (non-Claude) provider first (PLANO.md §4, rule 2). */
const DELEGABLE = new Set(['docs', 'tester']);
const LARGE_HANDOFF = 800;

export class Orchestrator {
  store: Store;
  engine: Engine;
  dataDir: string;
  cancelled = new Set<string>();
  results = new Map<string, Map<string, Result>>(); // runId → task_id → compact result
  endpoint = { url: '', token: '' }; // set once the HTTP server listens; orq calls back here

  constructor(store: Store, engine: Engine, dataDir: string) {
    this.store = store;
    this.engine = engine;
    this.dataDir = dataDir;
  }

  private enabled(role?: string) {
    return this.store.agents().filter((a) => a.enabled && (!role || a.role === role));
  }

  private external(a: Agent) {
    return this.engine.adapters.get(a.provider)?.external ?? true; // unknown provider: never trusted with sensitive work
  }

  /** Ordered candidates for a handoff: role match, sensitive filter, external-first for delegable roles, coder fallback. */
  route(h: Handoff): Agent[] {
    const all = this.enabled();
    const allowed = (a: Agent) => !h.sensitive || !this.external(a);
    const byCategory = (this.store.settings().routing[h.category] ?? []).map((id) => all.find((a) => a.id === id)).filter((a): a is Agent => Boolean(a) && allowed(a!));
    let c = all.filter((a) => a.role === h.role && allowed(a) && !byCategory.includes(a));
    const busy = (a: Agent) => this.store.liveState().running.filter((t: any) => t.agentId === a.id).length;
    c.sort((a, b) => (DELEGABLE.has(h.role) ? Number(this.external(b)) - Number(this.external(a)) : 0) || busy(a) - busy(b));
    c = [...byCategory, ...c];
    for (const a of all) if (a.role === 'coder' && !c.includes(a) && allowed(a)) c.push(a);
    return c;
  }

  planner(): Agent {
    const p = this.enabled('planner')[0];
    if (!p) throw httpError(400, 'Nenhum agente Planejador ativo.');
    return p;
  }

  start(prompt: string) {
    this.engine.workspace();
    const planner = this.planner();
    const runId = newId();
    const mode = this.store.settings().mode;
    this.store.createRun(runId, prompt, mode);
    this.store.emit({ runId, taskId: null, agentId: null, kind: 'run_started', payload: { prompt, mode } });
    const job = mode === 'agent' ? this.agentMode(runId, planner, prompt) : this.pipeline(runId, planner, prompt);
    job
      .catch((e) => ({ status: 'error', summary: e?.message ?? String(e) }))
      .then((r: any) => this.finish(runId, r.status, r.summary, r.results ?? []));
    return { runId };
  }

  private finish(runId: string, status: string, summary: string, results: Result[]) {
    if (this.cancelled.delete(runId)) status = 'cancelled';
    const usage = this.store.usageTotals(runId) as any[];
    const tok = (u: any) => u.input + u.output + u.cacheRead + u.cacheCreate;
    const opusTokens = usage.filter((u) => /opus/.test(u.model)).reduce((s, u) => s + tok(u), 0);
    const totalTokens = usage.reduce((s, u) => s + tok(u), 0);
    const payload = { status, summary, results: results.map((r) => ({ task_id: r.task_id, status: r.status, summary: r.summary })), opusTokens, totalTokens };
    this.store.endRun(runId, status, payload);
    this.store.emit({ runId, taskId: null, agentId: null, kind: 'run_done', payload });
  }

  private async pipeline(runId: string, planner: Agent, prompt: string) {
    const r = await this.engine.execute({ runId, agent: planner, prompt: `Request:\n${prompt}`, schema: planSchema });
    if (!r.ok) return { status: 'error', summary: `Planejador falhou: ${r.error}` };
    const plan = parseStructured(Plan, r.structured, r.text);
    if (!plan) return { status: 'error', summary: 'Planejador não devolveu um plano válido.' };

    const results: Result[] = [];
    const waves = this.store.settings().parallel ? disjointWaves(plan.tasks) : plan.tasks.map((t) => [t]);
    for (const wave of waves) {
      if (this.cancelled.has(runId)) break;
      results.push(...(await Promise.all(wave.map((h) => this.handle(runId, h)))));
    }
    this.results.delete(runId);
    const ok = results.length === plan.tasks.length && results.every((x) => x.status === 'done');
    return { status: ok ? 'done' : 'error', summary: plan.summary, results };
  }

  /** Send one handoff through routing, review loop and escalation. Returns the compact result only. */
  async handle(runId: string, h: Handoff): Promise<Result> {
    const r = await this.handleInner(runId, h);
    if (!this.results.has(runId)) this.results.set(runId, new Map());
    this.results.get(runId)!.set(h.task_id, r);
    return r;
  }

  private async handleInner(runId: string, h: Handoff): Promise<Result> {
    const candidates = this.route(h);
    if (!candidates.length) return fail(h, `Nenhum agente ativo para o papel ${h.role}.`);
    const reviewer = this.enabled('reviewer')[0];
    let agent = candidates[0];
    let escalated = false;
    let note: string | null = null;
    let loops = 0;
    const loopsMax = agent.limits.maxReviewLoops;

    for (let ci = 0; ; ) {
      if (this.cancelled.has(runId)) return fail(h, 'cancelado');
      const reason = escalated ? 'escalonado ao Planejador' : note ? 'correção pedida pelo revisor' : ci > 0 ? 'fallback de provedor' : '';
      const exec = await this.execHandoff(runId, agent, h, note, escalated, reason);

      if (!exec.ok && !escalated && ci + 1 < candidates.length && loops === 0) {
        agent = candidates[++ci]; // provider failure (not authenticated, crash): try next agent of the chain
        continue;
      }
      const result = exec.ok ? toResult(h.task_id, exec.structured, exec.text, false) : fail(h, exec.error ?? 'falhou');
      if (result.status === 'done' && !reviewer) return result;

      if (result.status === 'done') {
        const review = await this.review(runId, reviewer, h, result);
        if (review.status === 'done') return result;
        note = review.summary;
        loops++;
      } else {
        note = result.summary + (result.questions.length ? `\nQuestions: ${result.questions.join(' | ')}` : '');
      }
      if (escalated && (result.status !== 'done' || loops > loopsMax)) return { ...result, status: 'failed', summary: note ?? result.summary };
      if (result.status !== 'done' || loops > loopsMax) {
        agent = this.planner();
        escalated = true;
        loops = 0;
      }
    }
  }

  private execHandoff(runId: string, agent: Agent, h: Handoff, note: string | null, escalated: boolean, reason: string): Promise<ExecResult> {
    const body = JSON.stringify(h);
    const prompt = body + (note ? `\n\n${escalated ? 'Previous attempt / reviewer note' : 'Reviewer note, fix this'}:\n${note}` : '');
    this.store.emit({ runId, taskId: null, agentId: agent.id, kind: 'handoff', payload: { handoff: h, role: h.role, tokens: estimateTokens(prompt), warn: estimateTokens(prompt) > LARGE_HANDOFF, reason } });
    return this.engine.execute({
      runId,
      agent,
      role: escalated ? 'coder' : h.role,
      systemPrompt: escalated ? TEMPLATES.coder : undefined,
      prompt,
      schema: resultSchema,
    });
  }

  private async review(runId: string, reviewer: Agent, h: Handoff, r: Result): Promise<Result> {
    const prompt = JSON.stringify({ handoff: h, executor: { summary: r.summary, files_changed: r.files_changed, checks: r.checks } });
    this.store.emit({ runId, taskId: null, agentId: reviewer.id, kind: 'handoff', payload: { handoff: h, role: 'reviewer', tokens: estimateTokens(prompt), reason: 'revisão' } });
    const exec = await this.engine.execute({ runId, agent: reviewer, role: 'reviewer', prompt, schema: resultSchema });
    // A reviewer that crashes must not block the pipeline: accept the executor's own checks.
    return exec.ok ? toResult(h.task_id, exec.structured, exec.text, false) : { ...r, summary: `revisor indisponível: ${exec.error}` };
  }

  /** Agent mode: the planner delegates through the orq MCP server itself (phase 4). */
  private async agentMode(runId: string, planner: Agent, prompt: string) {
    // The planner process stays alive while every delegated sub-pipeline runs.
    const agent = { ...planner, limits: { ...planner.limits, timeoutSec: 3600 } };
    const r = await this.engine.execute({
      runId,
      agent,
      prompt: `Request:\n${prompt}`,
      systemPrompt: AGENT_MODE_PLANNER,
      extraServers: { orq: orqServer(this.endpoint.url, this.endpoint.token, runId) },
    });
    const results = [...(this.results.get(runId)?.values() ?? [])];
    this.results.delete(runId);
    const ok = r.ok && results.length > 0 && results.every((x) => x.status === 'done');
    return { status: ok ? 'done' : 'error', summary: r.ok ? r.text.slice(0, 1000) : `Planejador falhou: ${r.error}`, results };
  }

  cancel(runId: string) {
    this.cancelled.add(runId);
    for (const t of this.store.liveState().running as any[]) if (t.runId === runId) this.engine.cancel(t.id);
  }
}

function fail(h: Handoff, summary: string): Result {
  return { task_id: h.task_id, status: 'failed', summary, files_changed: [], checks: [], questions: [] };
}

/** Consecutive handoffs grouped while their file sets do not overlap (parallel option). */
export function disjointWaves(tasks: Handoff[]): Handoff[][] {
  const waves: Handoff[][] = [];
  let files = new Set<string>();
  for (const t of tasks) {
    const clash = !t.files.length || t.files.some((f) => files.has(f));
    if (!waves.length || clash) {
      waves.push([t]);
      files = new Set(t.files);
    } else {
      waves.at(-1)!.push(t);
      t.files.forEach((f) => files.add(f));
    }
  }
  return waves;
}

/** Tokens an MCP preset adds to every call: one lean Haiku call with it minus one without it. */
async function measure(orch: Orchestrator, id: string) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw httpError(404, 'preset não encontrado');
  const { rules, servers, missing } = resolveMcps([id]);
  if (missing.length) throw httpError(400, 'MCP indisponível: variável de ambiente ausente');
  const agent: Agent = {
    id: 'measure', name: 'measure', provider: 'claude-cli', model: 'haiku', role: 'custom', systemPrompt: null, effort: 'low',
    tools: null, mcps: [], inheritUserConfig: false, enabled: true, limits: { maxBudgetUsd: null, maxReviewLoops: 0, timeoutSec: 180 },
  };
  const cfg = Object.keys(servers).length ? writeMcpConfig(join(orch.engine.dataDir, 'mcp'), `measure-${id}`, servers) : null;
  const ctx = async (withPreset: boolean) => {
    let n = 0;
    for await (const ev of claude.run({
      agent, prompt: 'Reply with: ok', systemPrompt: 'Be brief.', cwd: orch.engine.workspace(), signal: new AbortController().signal,
      rules: withPreset ? rules : [], mcpConfigPath: withPreset ? cfg?.path : undefined,
    })) {
      if (ev.kind === 'usage') n += ev.input + ev.cacheRead + ev.cacheCreate;
      if (ev.kind === 'error') throw httpError(502, ev.message);
    }
    return n;
  };
  try {
    const tokens = Math.max(0, (await ctx(true)) - (await ctx(false)));
    const all = orch.store.mcpTokens();
    all[id] = tokens;
    orch.store.saveMcpTokens(all);
    return { id, schemaTokens: tokens };
  } finally {
    cfg?.remove();
  }
}

export function orqRoutes(orch: Orchestrator): Route[] {
  const runOf = (id: string) => {
    if (!orch.store.run(id)) throw httpError(404, 'run não encontrado');
    return id;
  };
  return [
    ['GET', /^\/api\/mcps$/, () => {
      const tokens = orch.store.mcpTokens();
      return PRESETS.map((p) => ({ id: p.id, label: p.label, kind: p.kind, providers: p.providers, available: !p.server || p.server() !== null, schemaTokens: tokens[p.id] ?? null }));
    }],
    ['POST', /^\/api\/mcps\/([\w-]+)\/measure$/, ({ params }) => measure(orch, params[0])],
    ['POST', /^\/api\/orq\/([\w-]+)\/delegate$/, ({ params, body }) =>
      orch.handle(runOf(params[0]), Handoff.parse(z.object({ handoff: z.unknown() }).parse(body).handoff))],
    ['GET', /^\/api\/orq\/([\w-]+)\/tasks\/([\w.-]+)$/, ({ params }) =>
      orch.results.get(runOf(params[0]))?.get(params[1]) ?? { task_id: params[1], status: 'unknown' }],
    ['GET', /^\/api\/orq\/([\w-]+)\/agents$/, () =>
      orch.store.agents().filter((a) => a.enabled).map((a) => ({ name: a.name, role: a.role, model: a.model, provider: a.provider }))],
    ['GET', /^\/api\/orq\/([\w-]+)\/notes$/, ({ params }) => orch.store.notes(runOf(params[0]))],
    ['POST', /^\/api\/orq\/([\w-]+)\/notes$/, ({ params, body }) => {
      orch.store.addNote(runOf(params[0]), 'planner', z.object({ text: z.string().min(1).max(2000) }).parse(body).text);
      return { ok: true };
    }],
    ['POST', /^\/api\/runs$/, ({ body }) => orch.start(z.object({ prompt: z.string().min(1).max(100_000) }).parse(body).prompt)],
    ['POST', /^\/api\/runs\/([\w-]+)\/cancel$/, ({ params }) => {
      orch.cancel(params[0]);
      return { ok: true };
    }],
  ];
}
