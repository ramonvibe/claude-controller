import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeScript, startApp, collect } from './helpers.ts';
import { disjointWaves } from '../server/orchestrator.ts';

const h = (id: string, role: string, files: string[] = ['a.ts']) => ({
  task_id: id, role, goal: `goal ${id}`, files, context: 'c', interfaces: 'i', steps: ['s'], acceptance: ['npm test'], constraints: [], sensitive: false,
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
    done('T2'), done('T2'), // docs card provider fails before spawning → coder fallback, reviewer
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
    assert.deepEqual(c.map(model), ['opus', 'haiku', 'haiku', 'haiku', 'haiku']);
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
