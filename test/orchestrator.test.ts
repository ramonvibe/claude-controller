import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeScript, startApp, collect } from './helpers.ts';
import { disjointWaves } from '../server/orchestrator.ts';

const h = (id: string, role: string, files: string[] = ['a.ts']) => ({
  task_id: id, role, category: role === 'docs' ? 'docs' : 'feature', goal: `goal ${id}`, files, context: 'c', interfaces: 'i', steps: ['s'], acceptance: ['npm test'], constraints: [], sensitive: false,
});
const done = (id: string) => ({ structured: { task_id: id, status: 'done', summary: `ok ${id}`, files_changed: ['a.ts'], checks: [{ cmd: 'npm test', ok: true }], questions: [] } });
const calls = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const model = (c: any) => c.args[c.args.indexOf('--model') + 1];
const sysPrompt = (c: any) => c.args[c.args.indexOf('--system-prompt') + 1];

async function runToEnd(app: Awaited<ReturnType<typeof startApp>>, prompt: string) {
  const c = collect(app.port, (evs) => evs.some((e) => e.kind === 'run_done'), 20000);
  await c.ready;
  const { runId } = await app.api('POST', '/api/runs', { prompt });
  const evs = await c.done;
  return { runId, evs, end: evs.find((e) => e.kind === 'run_done').payload };
}

test('pipeline: planner → coder → reviewer per handoff; provider failure falls back to coder', async () => {
  const log = fakeScript([
    { structured: { summary: 'plano', tasks: [h('T1', 'coder'), h('T2', 'docs', ['README.md'])] } },
    done('T1'), done('T1'), // coder, reviewer
    done('T2'), // docs card provider fails → coder fallback; docs skip review by default
  ]);

  const app = await startApp();
  try {
    const { evs, end, runId } = await runToEnd(app, 'Pedido original do usuário: adicionar flag');
    assert.equal(end.status, 'done', JSON.stringify(end));
    assert.deepEqual(end.results.map((r: any) => r.status), ['done', 'done']);
    const handoffs = evs.filter((e) => e.kind === 'handoff');
    assert.ok(handoffs.every((e) => e.payload.tokens > 0 && e.payload.tokens < 400));
    assert.ok(handoffs.some((e) => e.payload.reason === 'fallback de provedor'));
    const c = calls(log);
    assert.deepEqual(c.map(model), ['opus', 'haiku', 'haiku', 'haiku']);
    assert.ok(c[0].args.includes('--json-schema'));
    // Executors get only the handoff, never the user's original request.
    for (const x of c.slice(1)) assert.ok(!x.stdin.includes('Pedido original'), x.stdin);
    assert.ok(end.opusTokens > 0 && end.totalTokens > end.opusTokens);
    const run = await app.api('GET', `/api/runs/${runId}`);
    assert.equal(run.run.status, 'done');
  } finally {
    await app.app.close();
  }
});

test('blocked coder escalates to the Opus planner with coder template and a short context', async () => {
  const log = fakeScript([
    { structured: { summary: 'p', tasks: [h('T1', 'coder')] } },
    { structured: { task_id: 'T1', status: 'blocked', summary: 'interface ambígua', files_changed: [], checks: [], questions: ['qual tipo?'] } },
    done('T1'), // escalated planner
    done('T1'), // reviewer
  ]);
  const app = await startApp();
  try {
    const { end, evs } = await runToEnd(app, 'pedido');
    assert.equal(end.status, 'done');
    const c = calls(log);
    assert.deepEqual(c.map(model), ['opus', 'haiku', 'opus', 'haiku']);
    assert.match(sysPrompt(c[2]), /^You are a coder/);
    assert.match(c[2].stdin, /"task_id":"T1"/);
    assert.match(c[2].stdin, /interface ambígua/);
    assert.ok(evs.some((e) => e.kind === 'handoff' && e.payload.reason === 'escalonado ao Planejador'));
  } finally {
    await app.app.close();
  }
});

test('reviewer rejection beyond maxReviewLoops escalates; final failure marks run as error', async () => {
  const reject = { structured: { task_id: 'T1', status: 'failed', summary: 'falta teste', files_changed: [], checks: [], questions: [] } };
  fakeScript([
    { structured: { summary: 'p', tasks: [h('T1', 'coder')] } },
    done('T1'), reject, // coder, reviewer rejects (loop 1 > max 0) → escalate
    done('T1'), reject, // planner as coder, reviewer rejects again → fail
  ]);
  const app = await startApp();
  try {
    const coder = app.store.agents().find((a) => a.role === 'coder')!;
    await app.api('PUT', `/api/agents/${coder.id}`, { ...coder, limits: { ...coder.limits, maxReviewLoops: 0 } });
    const { end } = await runToEnd(app, 'pedido');
    assert.equal(end.status, 'error');
    assert.equal(end.results[0].status, 'failed');
    assert.match(end.results[0].summary, /falta teste/);
  } finally {
    await app.app.close();
  }
});

test('invalid plan ends the run with error', async () => {
  fakeScript([{ text: 'não sei planejar' }]);
  const app = await startApp();
  try {
    const { end } = await runToEnd(app, 'pedido');
    assert.equal(end.status, 'error');
    assert.match(end.summary, /plano válido/);
  } finally {
    await app.app.close();
  }
});

test('sensitive handoffs never route to external providers', async () => {
  const app = await startApp();
  try {
    const route = app.orch.route({ ...h('T', 'docs'), sensitive: true } as any);
    assert.ok(route.every((a) => a.provider === 'claude-cli'));
  } finally {
    await app.app.close();
  }
});

test('disjointWaves groups only consecutive non-overlapping handoffs', () => {
  const w = disjointWaves([h('1', 'coder', ['a']), h('2', 'coder', ['b']), h('3', 'coder', ['a']), h('4', 'coder', [])] as any);
  assert.deepEqual(w.map((x) => x.map((t) => t.task_id)), [['1', '2'], ['3'], ['4']]);
});

test('routing table: category picks the card first, then role match, then coder fallback', async () => {
  const app = await startApp();
  try {
    const agents = app.store.agents();
    const by = (n: string) => agents.find((a) => a.name === n)!;
    const r = app.orch.route(h('T', 'coder') as any).map((a) => a.name); // category feature → Coder-Chief
    assert.equal(r[0], 'Coder-Chief');
    const arch = app.orch.route({ ...h('T', 'coder'), category: 'architecture' } as any).map((a) => a.name);
    assert.equal(arch[0], 'Coder-Chief');
    const docs = app.orch.route(h('T', 'docs', ['README.md']) as any).map((a) => a.name);
    assert.deepEqual(docs.slice(0, 2), ['Docs (DeepSeek)', 'Coder-Chief']);
    await app.api('PUT', '/api/settings', { ...app.store.settings(), routing: { 'small-change': [by('Revisor').id] } });
    assert.equal(app.orch.route({ ...h('T', 'coder'), category: 'small-change' } as any)[0].name, 'Revisor');
  } finally {
    await app.app.close();
  }
});

test('tier: its agents come first; unknown tier routes as its category; sensitive skips external tier agents', async () => {
  const app = await startApp();
  try {
    const by = (n: string) => app.store.agents().find((a) => a.name === n)!;
    const plain = app.orch.route(h('T', 'coder') as any).map((a) => a.id);
    assert.deepEqual(app.orch.route({ ...h('T', 'coder'), tier: 'nao-existe' } as any).map((a) => a.id), plain);
    const chief = app.orch.route({ ...h('T', 'coder'), tier: 'coder-chief' } as any);
    assert.equal(chief[0].id, by('Coder-Chief').id); // tier agent beats the architecture route (Planejador)
    const minor = app.orch.route({ ...h('T', 'coder'), tier: 'coder-minor' } as any);
    assert.equal(minor[0].id, by('Coder-Chief').id); // disabled Coder-Minor card is skipped
    const safe = app.orch.route({ ...h('T', 'coder'), tier: 'coder-minor', sensitive: true } as any);
    assert.ok(safe.every((a) => a.provider === 'claude-cli'), JSON.stringify(safe.map((a) => a.provider)));
    assert.equal(safe[0].id, by('Coder-Chief').id);
  } finally {
    await app.app.close();
  }
});

test('tier agents: listed agents route first; sensitive handoffs skip the external ones', async () => {
  const app = await startApp();
  try {
    const dsh = app.store.agents().find((a) => a.name === 'Coder-Major (DeepSeek)')!;
    await app.api('PUT', `/api/agents/${dsh.id}`, { ...dsh, enabled: true });
    const s = app.store.settings();
    await app.api('PUT', '/api/settings', { ...s, tiers: s.tiers.map((t) => (t.id === 'coder-major' ? { ...t, agents: [dsh.id] } : t)) });
    const hand = { ...h('T', 'coder'), tier: 'coder-major' };
    assert.equal(app.orch.route(hand as any)[0].id, dsh.id);
    const safe = app.orch.route({ ...hand, sensitive: true } as any);
    assert.ok(safe.every((a) => a.provider === 'claude-cli'), JSON.stringify(safe.map((a) => a.provider)));
    assert.notEqual(safe[0].id, dsh.id);
  } finally {
    await app.app.close();
  }
});

test('tier review:false skips the reviewer', async () => {
  const log = fakeScript([
    { structured: { summary: 'p', tasks: [{ ...h('T1', 'coder'), tier: 'coder-chief' }] } },
    done('T1'), // coder only: no reviewer call
  ]);
  const app = await startApp();
  try {
    const s = app.store.settings();
    await app.api('PUT', '/api/settings', { ...s, tiers: s.tiers.map((t) => (t.id === 'coder-chief' ? { ...t, review: false } : t)) });
    const { end } = await runToEnd(app, 'pedido');
    assert.equal(end.status, 'done', JSON.stringify(end));
    assert.deepEqual(calls(log).map(model), ['opus', 'haiku']);
  } finally {
    await app.app.close();
  }
});

test('repo map: a cheap agent writes the brief once; the planner gets it; unchanged tree reuses it', async () => {
  const log = fakeScript([
    { text: 'BRIEF: projeto X em src/' }, // map agent (Revisor card reused as the cheap mapper here)
    { structured: { summary: 'p', tasks: [h('T1', 'coder')] } }, done('T1'), done('T1'),
    { structured: { summary: 'p', tasks: [h('T1', 'coder')] } }, done('T1'), done('T1'), // second run: no map call
  ]);
  const app = await startApp();
  try {
    const { execSync } = await import('node:child_process');
    execSync('git init -q', { cwd: app.ws });
    const mapper = app.store.agents().find((a) => a.name === 'Revisor')!;
    await app.api('PUT', '/api/settings', { ...app.store.settings(), repoMap: mapper.id });
    await runToEnd(app, 'pedido 1');
    await runToEnd(app, 'pedido 2');
    const c = calls(log);
    assert.match(sysPrompt(c[0]), /repository brief/);
    assert.match(c[1].stdin, /BRIEF: projeto X/);
    assert.match(c[4].stdin, /BRIEF: projeto X/); // cached
    assert.equal(c.length, 7);
  } finally {
    await app.app.close();
  }
});

const blocked = { structured: { task_id: 'T1', status: 'blocked', summary: 'fora do escopo do nível', files_changed: [], checks: [], questions: ['qual?'] } };

/** Two claude-cli coders: coder-minor → agent "minor" (haiku), coder-major → agent "major" (sonnet). */
async function escalationSetup(app: Awaited<ReturnType<typeof startApp>>, majorEscalatesTo?: string) {
  const minor = await app.api('POST', '/api/agents', { name: 'Minor teste', provider: 'claude-cli', model: 'haiku', role: 'coder', limits: {} });
  const major = await app.api('POST', '/api/agents', { name: 'Major teste', provider: 'claude-cli', model: 'sonnet', role: 'coder', limits: {} });
  const s = app.store.settings();
  const tiers = s.tiers.map((t) => {
    if (t.id === 'coder-minor') return { ...t, agents: [minor.id], escalateTo: 'coder-major' };
    if (t.id === 'coder-major') return { ...t, agents: [major.id], escalateTo: majorEscalatesTo };
    return t;
  });
  await app.api('PUT', '/api/settings', { ...s, tiers });
}

test('escalation: a blocked coder-minor is retried on coder-major before the planner', async () => {
  const log = fakeScript([
    { structured: { summary: 'p', tasks: [{ ...h('T1', 'coder'), tier: 'coder-minor' }] } },
    blocked, // coder-minor agent
    done('T1'), // coder-major agent
    done('T1'), // reviewer
  ]);
  const app = await startApp();
  try {
    await escalationSetup(app);
    const { end, evs } = await runToEnd(app, 'pedido');
    assert.equal(end.status, 'done', JSON.stringify(end));
    const c = calls(log);
    assert.deepEqual(c.map(model), ['opus', 'haiku', 'sonnet', 'haiku']);
    assert.match(c[2].stdin, /"tier":"coder-major"/);
    assert.ok(evs.some((e) => e.kind === 'handoff' && e.payload.reason === 'escalonado para coder-major'));
    assert.ok(!evs.some((e) => e.kind === 'handoff' && e.payload.reason === 'escalonado ao Planejador'));
  } finally {
    await app.app.close();
  }
});

test('escalation: when coder-major fails too, the planner takes over as coder', async () => {
  const log = fakeScript([
    { structured: { summary: 'p', tasks: [{ ...h('T1', 'coder'), tier: 'coder-minor' }] } },
    blocked, // coder-minor agent
    blocked, // coder-major agent: no further tier, so the planner
    done('T1'), // planner as coder
    done('T1'), // reviewer
  ]);
  const app = await startApp();
  try {
    await escalationSetup(app);
    const { end, evs } = await runToEnd(app, 'pedido');
    assert.equal(end.status, 'done', JSON.stringify(end));
    const c = calls(log);
    assert.deepEqual(c.map(model), ['opus', 'haiku', 'sonnet', 'opus', 'haiku']);
    assert.match(sysPrompt(c[3]), /^You are a coder/);
    assert.ok(evs.some((e) => e.kind === 'handoff' && e.payload.reason === 'escalonado ao Planejador'));
  } finally {
    await app.app.close();
  }
});

test('escalation cycle: coder-major pointing back to coder-minor ends at the planner, no loop', async () => {
  const log = fakeScript([
    { structured: { summary: 'p', tasks: [{ ...h('T1', 'coder'), tier: 'coder-minor' }] } },
    blocked, // coder-minor agent
    blocked, // coder-major agent; coder-minor already tried, so the planner
    done('T1'), // planner as coder
    done('T1'), // reviewer
  ]);
  const app = await startApp();
  try {
    await escalationSetup(app, 'coder-minor');
    const { end } = await runToEnd(app, 'pedido');
    assert.equal(end.status, 'done', JSON.stringify(end));
    assert.deepEqual(calls(log).map(model), ['opus', 'haiku', 'sonnet', 'opus', 'haiku']);
  } finally {
    await app.app.close();
  }
});

test('GET /api/orq/:run/tiers: enabled tiers only, tool names with _, category, agent labels; unknown run 404', async () => {
  const app = await startApp();
  try {
    app.store.createRun('r1', 'p', 'pipeline');
    const s = app.store.settings();
    // Old settings may lack category: stored without it, read back with the role's default.
    app.store.saveSettings({ ...s, tiers: s.tiers.map(({ category, ...t }) => (t.id === 'coder-minor' ? { ...t, enabled: false } : t)) as any });
    const tiers: any[] = await app.api('GET', '/api/orq/r1/tiers');
    assert.deepEqual(tiers.map((t) => t.tool), ['coder_chief', 'coder_major', 'tester', 'docs_writer']);
    assert.deepEqual([tiers[0].id, tiers[0].role, tiers[0].category, tiers[0].review, tiers[0].hint], ['coder-chief', 'coder', 'feature', true, 'complex or vital logic that must not fail']);
    assert.deepEqual(tiers[0].agents, ['Coder-Chief · haiku']);
    assert.deepEqual(tiers[1].agents, []); // its only card is disabled, so it is not listed
    assert.deepEqual([tiers[3].category, tiers[3].agents], ['docs', ['Docs (DeepSeek) · deepseek-flash']]);
    await assert.rejects(app.api('GET', '/api/orq/nope/tiers'), (e: any) => e.status === 404);
  } finally {
    await app.app.close();
  }
});
