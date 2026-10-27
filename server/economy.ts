// Economia: how many tokens each AI processed (and how much stayed out of Claude), plus what is still available.
import type { Store } from './db.ts';
import type { Engine } from './engine.ts';
import { balance, lastLimits, type ProviderConfig } from './openai.ts';
import type { Route } from './http.ts';

export function economy(store: Store, engine: Engine, days: number | null) {
  const since = days ? Date.now() - days * 86_400_000 : 0;
  const rows = store.db
    .prepare(`select u.agent_id agentId, u.model, count(*) calls, sum(u.input + u.cache_create) novos, sum(u.cache_read) cache,
      sum(u.output) saida, sum(u.cost_usd) costUsd, count(u.cost_usd) priced
      from usage u join runs r on r.id = u.run_id where r.started_at >= ? group by u.agent_id, u.model`)
    .all(since) as any[];
  const byModel = new Map<string, any>();
  for (const r of rows) {
    const agent = store.agent(r.agentId);
    // Unknown provider (card removed) counts as outside Claude, as routing does.
    const outside = engine.adapters.get(agent?.provider ?? '')?.external ?? true;
    const m = byModel.get(r.model) ?? { model: r.model, outside, agents: [], calls: 0, novos: 0, cache: 0, saida: 0, costUsd: 0, unpriced: 0 };
    if (agent && !m.agents.includes(agent.name)) m.agents.push(agent.name);
    m.calls += r.calls;
    m.novos += r.novos;
    m.cache += r.cache;
    m.saida += r.saida;
    m.costUsd += r.costUsd ?? 0;
    m.unpriced += r.calls - r.priced;
    byModel.set(r.model, m);
  }
  const models = [...byModel.values()].map((m) => ({ ...m, total: m.novos + m.cache + m.saida })).sort((a, b) => b.total - a.total);
  const sum = (xs: any[]) => xs.reduce((s, m) => s + m.total, 0);
  const runs = (store.db.prepare('select count(*) n from runs where started_at >= ?').get(since) as any).n;
  return {
    models,
    totals: {
      runs,
      claudeTokens: sum(models.filter((m) => !m.outside)),
      outsideTokens: sum(models.filter((m) => m.outside)),
      opusTokens: sum(models.filter((m) => /opus/.test(m.model))),
      claudeCostUsd: models.filter((m) => !m.outside).reduce((s, m) => s + m.costUsd, 0),
    },
  };
}

/** What is left per provider: Claude quota windows, API balances where the provider exposes one, last rate-limit headers. */
export async function available(store: Store, engine: Engine) {
  const w = (engine.lastRateLimit as any)?.unifiedWindows ?? {};
  const pct = (x: any) => (typeof x?.utilization === 'number' ? { usedPct: Math.round(x.utilization * 100), resetsAt: x.resetsAt ?? null } : null);
  const out: any[] = [{ id: 'claude-cli', label: 'Claude (assinatura)', kind: 'quota', fiveHour: pct(w.five_hour), sevenDay: pct(w.seven_day), note: 'A Anthropic informa só a % usada; atualiza a cada chamada ao Claude.' }];
  out.push({ id: 'dsh', label: 'DeepSeek (dsh, login)', kind: 'none', note: 'O dsh não expõe saldo; só se vê quando acaba ("Insufficient Balance").' });
  const providers = store.providers() as ProviderConfig[];
  const balances = await Promise.all(providers.map((p) => balance(p).catch((e) => ({ error: e.message }))));
  providers.forEach((p, i) => out.push({ id: p.id, label: p.label, kind: 'api', balance: balances[i], limits: lastLimits.get(p.id) ?? null }));
  return out;
}

export function economyRoutes(store: Store, engine: Engine): Route[] {
  return [
    ['GET', /^\/api\/economy$/, ({ query }) => economy(store, engine, Number(query.get('days')) || null)],
    ['GET', /^\/api\/economy\/available$/, () => available(store, engine)],
  ];
}
