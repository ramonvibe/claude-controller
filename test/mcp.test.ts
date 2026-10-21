import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fakeScript, startApp, collect } from './helpers.ts';
import { ORQ_ENTRY } from '../server/mcps.ts';

const h = { task_id: 'T1', role: 'coder', category: 'feature', goal: 'g', files: ['a.ts'], context: 'c', interfaces: 'i', steps: ['s'], acceptance: ['npm test'], constraints: [], sensitive: false };
const done = { structured: { task_id: 'T1', status: 'done', summary: 'feito', files_changed: ['a.ts'], checks: [], questions: [] } };
const parse = (r: any) => JSON.parse(r.content[0].text);

test('orq MCP server: tools route through the backend and return compact results', async () => {
  fakeScript([done, done, done, done]); // coder, reviewer, coder-chief, reviewer
  const app = await startApp();
  const runId = 'run1';
  app.store.createRun(runId, 'p', 'agent');
  // Fake backend in front of the app: serves /tiers with three coder tiers and records delegated bodies.
  const delegated: any[] = [];
  const fake = createServer(async (req, res) => {
    const body = Buffer.concat(await Array.fromAsync(req));
    if (req.url!.endsWith('/tiers'))
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
        { id: 'coder-chief', tool: 'coder_chief', label: 'Coder Chief', hint: 'complex or vital logic', role: 'coder', category: 'feature', review: true, agents: [] },
        { id: 'coder-major', tool: 'coder_major', label: 'Coder Major', hint: 'medium work that follows the design', role: 'coder', category: 'feature', review: true, agents: [] },
        { id: 'coder-minor', tool: 'coder_minor', label: 'Coder Minor', hint: 'small mechanical edits', role: 'coder', category: 'small-change', review: true, agents: [] },
      ]));
    if (req.url!.endsWith('/delegate')) delegated.push(JSON.parse(String(body)));
    const r = await fetch(app.base + req.url, { method: req.method, headers: { 'x-token': 'tok', 'content-type': 'application/json' }, body: body.length ? body : undefined });
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [ORQ_ENTRY], env: { ...process.env, ORQ_URL: `http://127.0.0.1:${(fake.address() as any).port}`, ORQ_TOKEN: 'tok', ORQ_RUN_ID: runId } as any }),
  );
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['coder_chief', 'coder_major', 'coder_minor', 'delegate_task', 'list_agents', 'notes_read', 'notes_write', 'task_status']);
    const agents = parse(await client.callTool({ name: 'list_agents', arguments: {} }));
    assert.ok(agents.some((a: any) => a.role === 'planner'));
    await client.callTool({ name: 'notes_write', arguments: { text: 'usar ESM' } });
    assert.equal(parse(await client.callTool({ name: 'notes_read', arguments: {} }))[0].text, 'usar ESM');
    const res = parse(await client.callTool({ name: 'delegate_task', arguments: { handoff: h } }));
    assert.deepEqual(Object.keys(res).sort(), ['checks', 'files_changed', 'questions', 'status', 'summary', 'task_id']);
    assert.equal(res.status, 'done');
    const { role, ...body } = h;
    assert.equal(parse(await client.callTool({ name: 'coder_chief', arguments: { handoff: body } })).status, 'done');
    assert.equal(delegated.at(-1).handoff.role, 'coder');
    assert.equal(delegated.at(-1).handoff.tier, 'coder-chief');
    assert.equal(parse(await client.callTool({ name: 'task_status', arguments: { task_id: 'T1' } })).summary, 'feito');
    const bad = await client.callTool({ name: 'delegate_task', arguments: { handoff: { task_id: 'x' } } });
    assert.ok(bad.isError);
  } finally {
    await client.close();
    fake.close();
    await app.app.close();
  }
});

test('agent mode: planner gets a 0600 per-task --mcp-config with orq, allowed via mcp__orq, removed afterwards', async () => {
  const log = fakeScript([{ text: 'resumo final' }]);
  const app = await startApp();
  try {
    const s = app.store.settings();
    await app.api('PUT', '/api/settings', { ...s, mode: 'agent' });
    const c = collect(app.port, (evs) => evs.some((e) => e.kind === 'run_done'));
    await c.ready;
    await app.api('POST', '/api/runs', { prompt: 'p' });
    const end = (await c.done).find((e) => e.kind === 'run_done').payload;
    assert.equal(end.status, 'error'); // nothing was delegated
    const call = JSON.parse(readFileSync(log, 'utf8').trim());
    assert.equal(call.mcpConfig.mode, '600');
    assert.deepEqual(call.mcpConfig.mcpServers.orq.args, [ORQ_ENTRY]);
    assert.equal(call.mcpConfig.mcpServers.orq.env.ORQ_TOKEN, 'tok');
    assert.ok(call.args.includes('mcp__orq'));
    assert.ok(call.args.includes('--strict-mcp-config'));
    assert.match(call.args[call.args.indexOf('--system-prompt') + 1], /delegate_task/);
    assert.ok(!existsSync(call.cfgPath), 'config file removed');
  } finally {
    await app.app.close();
  }
});

test('card MCP presets: rules and servers reach the CLI; missing env is reported, never fatal', async () => {
  const log = fakeScript([{ text: 'ok' }]);
  delete process.env.GITHUB_TOKEN;
  const app = await startApp();
  try {
    const coder = app.store.agents().find((a) => a.role === 'coder')!;
    await app.api('PUT', `/api/agents/${coder.id}`, { ...coder, mcps: ['context7', 'web-fetch', 'github'] });
    const c = collect(app.port, (evs) => evs.some((e) => e.kind === 'result' || e.kind === 'error'));
    await c.ready;
    await app.api('POST', '/api/tasks', { agentId: coder.id, prompt: 'x' });
    const evs = await c.done;
    assert.ok(evs.some((e) => e.kind === 'status' && /github/.test(e.payload.text)));
    const call = JSON.parse(readFileSync(log, 'utf8').trim());
    assert.deepEqual(Object.keys(call.mcpConfig.mcpServers), ['context7']);
    assert.ok(call.args.includes('mcp__context7') && call.args.includes('WebFetch'));
    const mcps = await app.api('GET', '/api/mcps');
    assert.equal(mcps.find((m: any) => m.id === 'github').available, false);
  } finally {
    await app.app.close();
  }
});

test('the app never edits the user MCP config (no `claude mcp add`)', () => {
  const src = ['server', 'mcp', 'server/adapters'].flatMap((d) =>
    readdirSync(new URL(`../${d}/`, import.meta.url)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(new URL(`../${d}/${f}`, import.meta.url), 'utf8')),
  );
  assert.ok(src.every((s) => !/['"]mcp['"],\s*['"](add|remove)/.test(s) && !/mcp add/.test(s)));
});
