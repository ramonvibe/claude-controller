import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { fakeScript, startApp, collect } from './helpers.ts';
import { claudeArgs, mapClaudeEvent } from '../server/adapters/claude.ts';
import { DENY } from '../server/roles.ts';
import { DEFAULT_TIERS, tiersNote } from '../server/tiers.ts';

const fixture = (f: string) => readFileSync(new URL(`../fixtures/claude/${f}`, import.meta.url), 'utf8');

test('mapClaudeEvent: recorded stream gives tool_use, text, rate limit, usage equal to modelUsage, result', () => {
  const lines = fixture('stream-tool.ndjson').trim().split('\n').map((l) => JSON.parse(l));
  const evs = lines.flatMap(mapClaudeEvent);
  const final = lines.at(-1);
  assert.deepEqual(evs.map((e) => e.kind), ['status', 'tool_use', 'rate_limit', 'delta', 'usage', 'result']);
  const u: any = evs.find((e) => e.kind === 'usage');
  const mu = final.modelUsage['claude-haiku-5-5'];
  assert.deepEqual([u.model, u.input, u.output, u.cacheRead, u.cacheCreate, u.costUsd], ['claude-haiku-5-5', mu.inputTokens, mu.outputTokens, mu.cacheReadInputTokens, mu.cacheCreationInputTokens, mu.costUSD]);
  assert.equal((evs.at(-1) as any).isError, false);
});

test('mapClaudeEvent: structured_output from --json-schema fixture', () => {
  const evs = mapClaudeEvent(JSON.parse(fixture('opus-schema.json')));
  const r: any = evs.at(-1);
  assert.deepEqual(r.structured, { status: 'done', summary: 'oi' });
  assert.equal((evs[0] as any).model, 'claude-opus-5-5');
});

test('claudeArgs: lean flags, verbose, dontAsk, deny list, one argv per rule', () => {
  const agent: any = { model: 'haiku', effort: null, inheritUserConfig: false, limits: { maxBudgetUsd: 0.5 } };
  const a = claudeArgs({ agent, prompt: '', systemPrompt: 'SP', rules: ['Read', 'Bash(npm test *)'], cwd: '.', signal: new AbortController().signal });
  for (const f of ['--verbose', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--setting-sources') + 1], '');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Bash');
  assert.ok(a.includes('Bash(npm test *)'));
  for (const d of DENY) assert.ok(a.includes(d), d);
  assert.ok(!a.includes('bypassPermissions'));
  assert.equal(a[a.indexOf('--max-budget-usd') + 1], '0.5');
  const inherit = claudeArgs({ agent: { ...agent, inheritUserConfig: true }, prompt: '', systemPrompt: 'SP', rules: [], cwd: '.', signal: new AbortController().signal });
  assert.ok(inherit.includes('--append-system-prompt') && !inherit.includes('--setting-sources'));
});

test('POST /api/tasks streams events over WS and stores usage equal to modelUsage', async () => {
  const log = fakeScript([{ text: 'ok', model: 'claude-haiku-5-5' }]);
  const { api, port, store, app } = await startApp();
  try {
    const coder = store.agents().find((a) => a.role === 'coder')!;
    const c = collect(port, (evs) => evs.some((e) => e.kind === 'result' || e.kind === 'error'));
    await c.ready;
    const { runId } = await api('POST', '/api/tasks', { agentId: coder.id, prompt: 'diga ok' });
    const all = await c.done;
    assert.equal(all[0].kind, 'run_started'); // lets the page lock Rodar and show the answer when run_done arrives
    const evs = all.filter((e) => !e.kind.startsWith('run_'));
    assert.deepEqual(evs.map((e) => e.kind), ['started', 'status', 'delta', 'rate_limit', 'usage', 'result']);
    assert.ok(evs.every((e) => e.agentId === coder.id && e.runId === runId));
    const [u]: any = store.usageTotals(runId);
    assert.deepEqual([u.model, u.input, u.output, u.cacheRead, u.cacheCreate], ['claude-haiku-5-5', 10, 20, 30, 40]);
    const call = JSON.parse(readFileSync(log, 'utf8').trim());
    assert.equal(call.stdin, 'diga ok'); // prompt via stdin, never positional
    const state = await api('GET', '/api/state');
    assert.equal(state.live.running.length, 0);
  } finally {
    await app.close();
  }
});

test('cancel kills the running process and ends the task with error', async () => {
  fakeScript([{ text: 'late', sleep: 30000 }]);
  const { api, port, store, app } = await startApp();
  try {
    const coder = store.agents().find((a) => a.role === 'coder')!;
    const c = collect(port, (evs) => evs.some((e) => e.kind === 'error'));
    await c.ready;
    await api('POST', '/api/tasks', { agentId: coder.id, prompt: 'x' });
    await new Promise((r) => setTimeout(r, 400));
    const state = await api('GET', '/api/state');
    assert.equal(state.live.running.length, 1);
    const t0 = Date.now();
    assert.deepEqual(await api('POST', `/api/tasks/${state.live.running[0].id}/cancel`), { cancelled: true });
    const evs = (await c.done).filter((e) => !e.kind.startsWith('run_'));
    assert.ok(Date.now() - t0 < 5000);
    assert.match(evs.at(-1).payload.message, /cancelado/);
    assert.equal((await api('GET', '/api/state')).live.running.length, 0);
  } finally {
    await app.close();
  }
});

test('security: token required, foreign Host rejected, bypassPermissions impossible', async () => {
  const { base, port, app, api } = await startApp();
  try {
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const status = await new Promise((res) =>
      request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.com', 'x-token': 'tok' } }, (r) => res(r.statusCode)).end(),
    );
    assert.equal(status, 421);
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /cc-token" content="tok"/);
    await assert.rejects(api('POST', '/api/agents', { name: 'x', provider: 'claude-cli', model: 'haiku', role: 'coder', permissionMode: 'bypassPermissions', limits: {} }).then((a) => {
      if ('permissionMode' in a) throw new Error('permissionMode accepted');
      throw new Error('ok-stripped');
    }), /ok-stripped/);
    await assert.rejects(api('POST', '/api/agents', { name: 'x', provider: 'nope', model: 'm', role: 'coder' }), /Provedor desconhecido/);
  } finally {
    await app.close();
  }
});

test('JSON schemas passed to --json-schema carry no $schema key (CLI rejects draft 2020-12 ref)', async () => {
  const { planSchema, resultSchema } = await import('../server/handoff.ts');
  for (const s of [planSchema, resultSchema]) assert.ok(!('$schema' in s));
});

test('nonexistent workspace: rejected on save (400) and a stale one fails the run with 400, not 500', async () => {
  const { api, store, app } = await startApp();
  try {
    const s = store.settings();
    await assert.rejects(api('PUT', '/api/settings', { ...s, workspace: '/home/nao-existe/' }), (e: any) => e.status === 400 && /não existe/.test(e.message));
    store.saveSettings({ ...s, workspace: '/home/nao-existe/' }); // saved by an older version
    await assert.rejects(api('POST', '/api/runs', { prompt: 'x' }), (e: any) => e.status === 400 && /não existe/.test(e.message));
  } finally {
    await app.close();
  }
});

test('settings: duplicate tier ids are rejected with 400', async () => {
  const { api, store, app } = await startApp();
  try {
    const s = store.settings();
    await assert.rejects(api('PUT', '/api/settings', { ...s, tiers: [s.tiers[0], s.tiers[0]] }), (e: any) => e.status === 400 && /Duplicate tier id/.test(e.message));
  } finally {
    await app.close();
  }
});

test('settings: tier ids with spaces, uppercase or the reserved delegate_task name are rejected with 400', async () => {
  const { api, store, app } = await startApp();
  try {
    const s = store.settings();
    for (const id of ['Coder Chief', 'delegate_task']) {
      await assert.rejects(api('PUT', '/api/settings', { ...s, tiers: [{ ...s.tiers[0], id }] }), (e: any) => e.status === 400, id);
    }
  } finally {
    await app.close();
  }
});

test('tiersNote: lists enabled tiers only, empty when none is enabled', () => {
  const tiers = DEFAULT_TIERS.map((t) => (t.id === 'coder-minor' ? { ...t, enabled: false } : t));
  const note = tiersNote(tiers);
  assert.ok(!note.includes('coder-minor'));
  assert.equal(note.split('\n').length, 4);
  assert.match(note, /^- coder-chief \(coder\): /);
  assert.equal(tiersNote(DEFAULT_TIERS.map((t) => ({ ...t, enabled: false }))), '');
});

test('settings stored without tiers come back with the 5 default tiers', async () => {
  const { store, app } = await startApp();
  try {
    const { tiers, ...noTiers } = store.settings();
    store.saveSettings(noTiers as any); // saved by an older version without the tiers field
    assert.deepEqual(store.settings().tiers.map((t) => t.id), ['coder-chief', 'coder-major', 'coder-minor', 'tester', 'docs-writer']);
  } finally {
    await app.close();
  }
});

test('cards saved by older versions (no skills/mcps fields) load with defaults', async () => {
  const { api, store, app } = await startApp();
  try {
    const old = { id: 'old1', name: 'Velho', provider: 'claude-cli', model: 'haiku', role: 'coder', systemPrompt: null, tools: null, inheritUserConfig: false, limits: { maxBudgetUsd: null, maxReviewLoops: 2, timeoutSec: 600 }, enabled: true };
    store.db.prepare('insert into agents (id, pos, data) values (?, 99, ?)').run(old.id, JSON.stringify(old));
    const a = (await api('GET', '/api/state')).agents.find((x: any) => x.id === 'old1');
    assert.deepEqual([a.skills, a.mcps, a.effort], [null, [], null]);
  } finally {
    await app.close();
  }
});

test('one request at a time: a second run while one is running gets 409', async () => {
  const app = await startApp();
  try {
    app.store.createRun('busy1', 'p', 'pipeline');
    await assert.rejects(app.api('POST', '/api/runs', { prompt: 'again' }), (e: any) => e.status === 409);
    app.store.endRun('busy1', 'done', {});
  } finally {
    await app.app.close();
  }
});
