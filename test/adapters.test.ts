import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmp } from './helpers.ts';

const FAKE_DSH = fileURLToPath(new URL('./fake-dsh.mjs', import.meta.url));
chmodSync(FAKE_DSH, 0o755);
process.env.DSH_BIN = FAKE_DSH;

const { loadAdapters } = await import('../server/adapters/index.ts');
const { mapDshEvent, default: dsh } = await import('../server/adapters/dsh.ts');
const fixture = (f: string) => readFileSync(new URL(`../fixtures/dsh/${f}.ndjson`, import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const agent: any = { model: 'deepseek-flash', limits: { timeoutSec: 30 }, inheritUserConfig: false };
async function collectRun(cwd: string) {
  const out: any[] = [];
  for await (const ev of dsh.run({ agent, prompt: 'TAREFA', systemPrompt: 'PAPEL', rules: [], cwd, signal: new AbortController().signal })) out.push(ev);
  return out;
}

test('contract: every adapter file is loaded and implements the Adapter shape', async () => {
  const adapters = await loadAdapters();
  assert.deepEqual([...adapters.keys()].sort(), ['claude-cli', 'dsh']);
  for (const a of adapters.values()) {
    assert.equal(typeof a.label, 'string');
    assert.ok(Array.isArray(a.models) && a.models.length > 0);
    assert.equal(typeof a.external, 'boolean');
    assert.equal(typeof a.supportsSchema, 'boolean');
    assert.equal(typeof a.detect, 'function');
    assert.equal(typeof a.run, 'function');
  }
});

test('dsh: recorded auth failures map to error events with their codes', () => {
  for (const [name, code] of [['missing-credential', 'MISSING_CREDENTIAL'], ['account-sign-in-required', 'ACCOUNT_SIGN_IN_REQUIRED']]) {
    const evs = fixture(name).flatMap((o) => mapDshEvent(o, 'deepseek-flash'));
    assert.deepEqual(evs.map((e) => e.kind), ['status', 'error'], name);
    assert.equal((evs[1] as any).code, code);
  }
});

test('dsh: authenticated recorded run gives text, real usage and result', () => {
  const evs = fixture('ok-account').flatMap((o) => mapDshEvent(o, 'deepseek-flash'));
  assert.deepEqual(evs.map((e) => e.kind), ['status', 'delta', 'usage', 'result']);
  const u: any = evs[2];
  assert.deepEqual([u.input, u.output, u.source, u.costUsd], [5751, 2, 'dsh-events', null]);
  assert.equal((evs[3] as any).text, 'ok');
});

test('dsh: detect reports "não autenticado" for the observed sign-in error', async () => {
  process.env.FAKE_DSH = 'account-sign-in-required';
  const d = await dsh.detect();
  assert.equal(d.auth, 'não autenticado');
  assert.equal(d.ok, false);
  assert.match(d.detail, /ACCOUNT_SIGN_IN_REQUIRED/);
});

test('dsh: run sends role template + task via stdin with the account patch; estimates usage without price', async () => {
  process.env.FAKE_DSH = 'ok';
  process.env.FAKE_DSH_LOG = join(tmp(), 'log');
  const evs = await collectRun(tmp());
  assert.deepEqual(evs.map((e) => e.kind), ['status', 'usage', 'result']);
  const usage = evs[1];
  assert.equal(usage.source, 'estimado');
  assert.equal(usage.costUsd, null);
  const call = JSON.parse(readFileSync(process.env.FAKE_DSH_LOG, 'utf8').trim());
  assert.deepEqual(call.args.filter((a: string) => !a.endsWith('.yml')), ['--profile', 'headless', '--patch', '--json', '-']);
  assert.match(call.stdin, /^PAPEL[\s\S]*TAREFA$/);
  assert.match(call.patch, /provider: deepseek-account/);
  for (const id of ['authorization', 'credentials', 'deepseek-account']) assert.match(call.patch, new RegExp(`id: ${id}\\n.*\\n  disabled: false`));
  assert.match(call.patch, /model: "deepseek-flash"/);
});

test('dsh: a commit made by the agent is reported as an error', async () => {
  process.env.FAKE_DSH = 'commit';
  const ws = tmp();
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: ws });
  const evs = await collectRun(ws);
  assert.equal(evs.at(-1).kind, 'error');
  assert.equal(evs.at(-1).code, 'COMMIT_FORBIDDEN');
});

test('dsh: unauthenticated run in the pipeline falls back to the Claude coder', async () => {
  process.env.FAKE_DSH = 'account-sign-in-required';
  const { fakeScript, startApp, collect } = await import('./helpers.ts');
  const h = { task_id: 'T1', role: 'docs', category: 'docs', goal: 'g', files: ['README.md'], context: 'c', interfaces: 'i', steps: ['s'], acceptance: [], constraints: [], sensitive: false };
  const done = { structured: { task_id: 'T1', status: 'done', summary: 'ok', files_changed: [], checks: [], questions: [] } };
  fakeScript([{ structured: { summary: 'p', tasks: [h] } }, done, done]);
  const app = await startApp();
  try {
    const c = collect(app.port, (evs) => evs.some((e) => e.kind === 'run_done'));
    await c.ready;
    await app.api('POST', '/api/runs', { prompt: 'docs' });
    const evs = await c.done;
    const docsAgent = app.store.agents().find((a) => a.provider === 'dsh')!;
    assert.ok(evs.some((e) => e.kind === 'error' && e.agentId === docsAgent.id && e.payload.code === 'ACCOUNT_SIGN_IN_REQUIRED'));
    assert.ok(evs.some((e) => e.kind === 'handoff' && e.payload.reason === 'fallback de provedor'));
    assert.equal(evs.find((e) => e.kind === 'run_done').payload.status, 'done');
  } finally {
    await app.app.close();
  }
});
