import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, fakeScript, startApp, collect } from './helpers.ts';
import { snapshotTree } from '../server/proc.ts';

process.env.CC_ENV_FILE = join(tmp(), '.env');

const h = (id: string, role: string, category: string) => ({
  task_id: id, role, category, goal: `g ${id}`, files: ['a.txt'], context: 'c', interfaces: 'i', steps: ['s'], acceptance: [], constraints: [], sensitive: false,
});
const done = (id: string) => ({ structured: { task_id: id, status: 'done', summary: `ok ${id}`, files_changed: ['a.txt'], checks: [], questions: [] } });

test('snapshotTree: captures untracked + modified files without touching the user index', async () => {
  const ws = tmp();
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: ws });
  writeFileSync(join(ws, 'a.txt'), 'one\n');
  const before = await snapshotTree(ws);
  writeFileSync(join(ws, 'a.txt'), 'two\n');
  const after = await snapshotTree(ws);
  assert.ok(before && after && before !== after);
  assert.match(execSync(`git diff ${before} ${after}`, { cwd: ws }).toString(), /-one\n\+two/);
  assert.equal(execSync('git status --porcelain', { cwd: ws }).toString().trim(), '?? a.txt'); // still untracked, index untouched
  assert.equal(await snapshotTree(tmp()), null); // not a repo
});

test('pre-flight flags a disconnected first card and offers a connected alternative; override routes around it', async () => {
  process.env.FAKE_DSH = 'account-sign-in-required';
  fakeScript([{ structured: { summary: 'p', tasks: [h('T1', 'docs', 'docs')] } }, done('T1')]);
  const app = await startApp();
  try {
    const pf = await app.api('GET', '/api/preflight');
    const docs = pf.problems.find((p: any) => p.category === 'docs');
    assert.equal(docs.agent.provider, 'dsh');
    assert.equal(docs.alternative.name, 'Codificador');
    const c = collect(app.port, (evs) => evs.some((e) => e.kind === 'run_done'));
    await c.ready;
    const { runId } = await app.api('POST', '/api/runs', { prompt: 'docs', overrides: { docs: docs.alternative.id } });
    const evs = await c.done;
    const dshAgent = app.store.agents().find((a) => a.provider === 'dsh')!;
    assert.ok(!evs.some((e) => e.agentId === dshAgent.id), 'disconnected card never tried');

    const t = await app.api('GET', `/api/runs/${runId}/trace`);
    assert.deepEqual(t.tasks.map((x: any) => [x.role, x.category]), [['planner', null], ['docs', 'docs']]); // docs: no review by default
    const tk = t.tasks[1].tokens;
    assert.deepEqual([tk.novos, tk.reaproveitados, tk.saida], [50, 30, 20]); // fake: in 10 + cacheCreate 40, cacheRead 30, out 20
    assert.equal(t.totals.outsideTokens, 0);
    assert.ok(t.totals.claudeTokens > 0 && t.totals.opusTokens > 0);
    assert.deepEqual(t.totals.quota, { before: 0.1, after: 0.1 });
    assert.equal(t.tasks[1].summary, 'ok T1');
    const d = await app.api('GET', `/api/tasks/${t.tasks[1].id}/diff`);
    assert.match(d.note, /git/); // workspace is not a repo in this test
  } finally {
    await app.app.close();
  }
});

test('keys: written once to the local .env (0600), readable by providers, never echoed back', async () => {
  const app = await startApp();
  try {
    const r = await app.api('POST', '/api/keys', { name: 'GROQ_API_KEY', value: 'gsk_abcdefgh123' });
    assert.deepEqual(r, { ok: true, name: 'GROQ_API_KEY' });
    await app.api('POST', '/api/keys', { name: 'GROQ_API_KEY', value: 'gsk_replaced999' });
    const text = readFileSync(process.env.CC_ENV_FILE!, 'utf8');
    assert.equal(text, 'GROQ_API_KEY=gsk_replaced999\n');
    assert.equal(statSync(process.env.CC_ENV_FILE!).mode & 0o777, 0o600);
    const { getKey } = await import('../server/openai.ts');
    assert.equal(getKey('GROQ_API_KEY'), 'gsk_replaced999');
    const cat = await app.api('GET', '/api/catalog');
    assert.equal(cat.find((c: any) => c.id === 'groq').keySet, true);
    assert.ok(!JSON.stringify(cat).includes('gsk_'));
    await assert.rejects(app.api('POST', '/api/keys', { name: 'X_KEY', value: 'abc def\nEVIL=1' }), (e: any) => e.status === 400);
  } finally {
    await app.app.close();
  }
});
