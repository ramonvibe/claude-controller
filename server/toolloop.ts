// Tool-calling loop for chat-completions models (OpenAI-compatible APIs). The model only gets the tools its
// permission rules allow, and every tool is confined to the workspace with the same denials as Claude agents.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, basename } from 'node:path';
import { spawn } from 'node:child_process';
import type { AdapterEvent } from './types.ts';

const MAX_OUT = 8000; // chars per tool result: every step resends the whole history
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'build', '.venv', '__pycache__']);
const SECRET = (p: string) => {
  const b = basename(p);
  return b.startsWith('.env') || b.endsWith('.pem') || b.endsWith('.key');
};
const META = /[;&|`$<>\n\\]/;
const DENIED_CMD = [/^git\s+(commit|push)\b/, /^rm\s+-[a-zA-Z]*[rR]/];

export type Sandbox = { cwd: string; read: boolean; write: boolean; commands: string[] };

/** Translate Claude-style permission rules into what the loop allows. */
export function sandboxFromRules(cwd: string, rules: string[]): Sandbox {
  const commands = rules
    .map((r) => /^Bash\((.+?)( \*)?\)$/.exec(r)?.[1])
    .filter((c): c is string => Boolean(c));
  return {
    cwd: realpathSync(cwd),
    read: rules.some((r) => ['Read', 'Grep', 'Glob'].includes(r)),
    write: rules.some((r) => ['Edit', 'Write'].includes(r)),
    commands: [...new Set(commands)],
  };
}

function inside(sb: Sandbox, p: unknown, forWrite = false): string {
  if (typeof p !== 'string' || !p) throw new Error('path obrigatório');
  const abs = resolve(sb.cwd, p);
  // Resolve symlinks of the deepest existing ancestor so a link cannot point outside.
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = join(realpathSync(probe), relative(probe, abs));
  if (real !== sb.cwd && !real.startsWith(sb.cwd + sep)) throw new Error('fora do workspace');
  if (SECRET(real)) throw new Error('arquivo de segredo bloqueado');
  if (forWrite && real.split(sep).includes('.git')) throw new Error('.git é somente leitura');
  return real;
}

function* walk(dir: string, root: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name), root);
    } else if (e.isFile()) yield relative(root, join(dir, e.name));
  }
}

const globRe = (g: string) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

function runCommand(sb: Sandbox, cmd: string, signal: AbortSignal): Promise<string> {
  const c = cmd.trim();
  if (META.test(c)) return Promise.resolve('negado: sem ; & | ` $ < > ou quebras de linha');
  if (DENIED_CMD.some((re) => re.test(c))) return Promise.resolve('negado: comando proibido');
  if (!sb.commands.some((a) => c === a || c.startsWith(a + ' '))) return Promise.resolve(`negado: permitidos ${sb.commands.join(', ') || 'nenhum'}`);
  return new Promise((res) => {
    const child = spawn('sh', ['-c', c], { cwd: sb.cwd, signal, timeout: 120000 });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => res(`erro: ${e.message}`));
    child.on('close', (code) => res(`exit ${code}\n${out.slice(-MAX_OUT)}`));
  });
}

type ToolDef = { name: string; description: string; parameters: object; run: (a: any, signal: AbortSignal) => string | Promise<string> };

export function buildTools(sb: Sandbox): ToolDef[] {
  const str = (d: string) => ({ type: 'string', description: d });
  const obj = (props: Record<string, object>, required: string[]) => ({ type: 'object', properties: props, required });
  const tools: ToolDef[] = [];
  if (sb.read)
    tools.push(
      {
        name: 'read_file', description: 'Read a text file of the repository (relative path).',
        parameters: obj({ path: str('relative path') }, ['path']),
        run: (a) => {
          const t = readFileSync(inside(sb, a.path), 'utf8');
          return t.length > MAX_OUT * 4 ? t.slice(0, MAX_OUT * 4) + '\n…(truncado)' : t;
        },
      },
      {
        name: 'list_files', description: 'List repository files, optionally filtered by a glob like "src/*.ts".',
        parameters: obj({ pattern: str('optional glob, * matches anything') }, []),
        run: (a) => {
          const re = a.pattern ? globRe(a.pattern) : null;
          const files = [...walk(sb.cwd, sb.cwd)].filter((f) => !re || re.test(f)).slice(0, 500);
          return files.join('\n') || '(nenhum arquivo)';
        },
      },
      {
        name: 'search', description: 'Search a regular expression in repository files; returns path:line: text.',
        parameters: obj({ pattern: str('JavaScript regular expression') }, ['pattern']),
        run: (a) => {
          const re = new RegExp(a.pattern);
          const hits: string[] = [];
          for (const f of walk(sb.cwd, sb.cwd)) {
            if (SECRET(f) || statSync(join(sb.cwd, f)).size > 1_000_000) continue;
            readFileSync(join(sb.cwd, f), 'utf8').split('\n').forEach((l, i) => re.test(l) && hits.length < 100 && hits.push(`${f}:${i + 1}: ${l.slice(0, 200)}`));
            if (hits.length >= 100) break;
          }
          return hits.join('\n') || '(nada encontrado)';
        },
      },
    );
  if (sb.write)
    tools.push(
      {
        name: 'write_file', description: 'Create or overwrite a file with the full content.',
        parameters: obj({ path: str('relative path'), content: str('full file content') }, ['path', 'content']),
        run: (a) => {
          const p = inside(sb, a.path, true);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, String(a.content));
          return 'ok';
        },
      },
      {
        name: 'edit_file', description: 'Replace one exact, unique occurrence of old_string with new_string in a file.',
        parameters: obj({ path: str('relative path'), old_string: str('exact text, must occur once'), new_string: str('replacement') }, ['path', 'old_string', 'new_string']),
        run: (a) => {
          const p = inside(sb, a.path, true);
          const t = readFileSync(p, 'utf8');
          const n = t.split(String(a.old_string)).length - 1;
          if (n !== 1) return `erro: old_string ocorre ${n} vezes`;
          writeFileSync(p, t.replace(String(a.old_string), () => String(a.new_string)));
          return 'ok';
        },
      },
    );
  if (sb.commands.length)
    tools.push({
      name: 'run_command', description: `Run one allowed shell command in the repository root. Allowed: ${sb.commands.join(', ')}.`,
      parameters: obj({ command: str('the command') }, ['command']),
      run: (a, signal) => runCommand(sb, String(a.command ?? ''), signal),
    });
  return tools;
}

export type LoopOpts = {
  url: string; // full chat/completions URL
  headers: Record<string, string>;
  model: string;
  systemPrompt: string;
  prompt: string;
  sandbox: Sandbox;
  signal: AbortSignal;
  maxSteps?: number;
  extraBody?: object;
  retryDelayMs?: number;
  free?: boolean; // known-free model: cost 0 instead of "sem preço"
  onLimits?: (h: Record<string, string>) => void; // x-ratelimit-* headers of each response
};

async function post(o: LoopOpts, body: object): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(o.url, { method: 'POST', headers: { 'content-type': 'application/json', ...o.headers }, body: JSON.stringify(body), signal: o.signal });
    const limits = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith('x-ratelimit-')));
    if (Object.keys(limits).length) o.onLimits?.(limits);
    if (r.ok) return r.json();
    const text = (await r.text()).slice(0, 400);
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      const wait = Number(r.headers.get('retry-after')) * 1000 || (o.retryDelayMs ?? 2000) * 2 ** attempt;
      await new Promise((res) => setTimeout(res, Math.min(wait, 30000)));
      continue;
    }
    throw Object.assign(new Error(`HTTP ${r.status}: ${text}`), { code: r.status === 429 ? 'RATE_LIMIT' : `HTTP_${r.status}` });
  }
}

export async function* toolLoop(o: LoopOpts): AsyncGenerator<AdapterEvent> {
  const tools = buildTools(o.sandbox);
  const messages: any[] = [
    { role: 'system', content: o.systemPrompt },
    { role: 'user', content: o.prompt },
  ];
  const spec = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  for (let step = 0; step < (o.maxSteps ?? 40); step++) {
    let res: any;
    try {
      res = await post(o, { model: o.model, messages, ...(spec.length ? { tools: spec, tool_choice: 'auto' } : {}), ...o.extraBody });
    } catch (e: any) {
      yield { kind: 'error', message: o.signal.aborted ? 'cancelado ou tempo esgotado' : e.message, code: e.code };
      return;
    }
    const u = res.usage;
    if (u)
      yield {
        kind: 'usage', model: res.model ?? o.model, input: (u.prompt_tokens ?? 0) - (u.prompt_tokens_details?.cached_tokens ?? 0), output: u.completion_tokens ?? 0,
        cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0, cacheCreate: 0, costUsd: typeof u.cost === 'number' ? u.cost : o.free ? 0 : null, source: 'api',
      };
    const msg = res.choices?.[0]?.message;
    if (!msg) {
      yield { kind: 'error', message: `resposta sem mensagem: ${JSON.stringify(res).slice(0, 300)}` };
      return;
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.content && msg.tool_calls?.length) yield { kind: 'delta', text: msg.content };
    if (!msg.tool_calls?.length) {
      yield { kind: 'result', text: msg.content ?? '', isError: false };
      return;
    }
    for (const call of msg.tool_calls) {
      const tool = tools.find((t) => t.name === call.function?.name);
      let args: any = {};
      try {
        args = JSON.parse(call.function?.arguments || '{}');
      } catch {}
      yield { kind: 'tool_use', name: call.function?.name ?? '?', input: args };
      let out: string;
      try {
        out = tool ? await tool.run(args, o.signal) : `erro: ferramenta desconhecida ${call.function?.name}`;
      } catch (e: any) {
        out = `erro: ${e.message}`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: out.slice(0, MAX_OUT) });
    }
  }
  yield { kind: 'error', message: `limite de ${o.maxSteps ?? 40} passos atingido`, code: 'MAX_STEPS' };
}
