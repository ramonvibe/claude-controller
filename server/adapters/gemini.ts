import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ndjson, capture, gitHead } from '../proc.ts';
import type { Adapter, AdapterEvent, Detect, RunInput } from '../types.ts';

/** `gemini` when installed globally, otherwise the pinned package through npx. */
export function geminiCmd(): [string, string[]] {
  if (process.env.GEMINI_BIN) return [process.env.GEMINI_BIN, []];
  return ['npx', ['-y', '@google/gemini-cli@0.65.0']];
}
// "Login with Google" (free tier): selects the auth type without touching ~/.gemini/settings.json.
export const GEMINI_ENV = { ...process.env, GOOGLE_GENAI_USE_GCA: 'true' };
export const geminiLoggedIn = () => existsSync(join(homedir(), '.gemini', 'oauth_creds.json'));

/**
 * Map one `gemini -o stream-json` event. shortcut: shapes follow the gemini-cli headless docs and were not
 * recorded here yet (needs your login); unknown events are ignored. Record a fixture after the first real run.
 */
export function mapGeminiEvent(o: any): AdapterEvent[] {
  switch (o?.type) {
    case 'init':
      return [{ kind: 'status', text: `modelo ${o.model ?? '?'}` }];
    case 'message':
      return o.role === 'assistant' && o.content ? [{ kind: 'delta', text: String(o.content) }] : [];
    case 'tool_use':
      return [{ kind: 'tool_use', name: o.tool_name ?? o.name ?? '?', input: o.parameters ?? o.input }];
    case 'error':
      return [{ kind: 'error', message: o.message ?? JSON.stringify(o).slice(0, 300) }];
    case 'result': {
      const st = o.stats ?? {};
      const out: AdapterEvent[] = [];
      if (typeof st.input_tokens === 'number' || typeof st.output_tokens === 'number')
        out.push({ kind: 'usage', model: o.model ?? 'gemini', input: (st.input_tokens ?? 0) - (st.cached ?? 0), output: st.output_tokens ?? 0, cacheRead: st.cached ?? 0, cacheCreate: 0, costUsd: 0, source: 'api' });
      if (o.status && o.status !== 'success') out.push({ kind: 'error', message: o.error?.message ?? `gemini: ${o.status}` });
      return out;
    }
    default:
      return [];
  }
}

const gemini: Adapter = {
  id: 'gemini-cli',
  label: 'Gemini CLI (login Google)',
  external: true,
  models: ['default'],
  supportsSchema: false,

  async detect(): Promise<Detect> {
    const [cmd, pre] = geminiCmd();
    const v = await capture(cmd, [...pre, '--version'], 120000);
    if (v.code !== 0) return { ok: false, version: null, auth: 'desconhecido', detail: `gemini-cli indisponível: ${v.err.trim().slice(0, 200)}`, capabilities: {} };
    const auth = geminiLoggedIn() ? 'ok' : 'não autenticado';
    return {
      ok: auth === 'ok', version: v.out.trim(), auth,
      detail: `${auth === 'ok' ? 'login Google encontrado' : 'use Conectar em Provedores'} · permissões: --approval-mode auto_edit (edita sem perguntar; shell exige aprovação)`,
      capabilities: {},
    };
  },

  async *run(i: RunInput) {
    if (!geminiLoggedIn()) {
      yield { kind: 'error', message: 'Gemini CLI sem login: use Conectar em Provedores', code: 'ACCOUNT_SIGN_IN_REQUIRED' };
      return;
    }
    const [cmd, pre] = geminiCmd();
    const args = [...pre, '-p', 'Do the task described above.', '-o', 'stream-json', '--approval-mode', 'auto_edit', '--skip-trust'];
    if (i.agent.model !== 'default') args.push('-m', i.agent.model);
    const headBefore = await gitHead(i.cwd);
    let text = '';
    let failed = false;
    for await (const item of ndjson(cmd, args, { cwd: i.cwd, stdin: `${i.systemPrompt}\n\n---\n\n${i.prompt}`, signal: i.signal, timeoutMs: i.agent.limits.timeoutSec * 1000, env: GEMINI_ENV })) {
      if ('json' in item) {
        for (const ev of mapGeminiEvent(item.json)) {
          if (ev.kind === 'delta') text += ev.text;
          if (ev.kind === 'error') failed = true;
          yield ev;
        }
      } else if ('exit' in item && !failed && (item.exit.code !== 0 || !text)) {
        failed = true;
        yield { kind: 'error', message: item.exit.aborted ? 'cancelado ou tempo esgotado' : item.exit.stderr.trim().slice(-500) || `gemini saiu com código ${item.exit.code}` };
      }
    }
    if (failed) return;
    if (headBefore && (await gitHead(i.cwd)) !== headBefore) yield { kind: 'error', message: 'o agente Gemini criou um commit; revise com git log', code: 'COMMIT_FORBIDDEN' };
    else yield { kind: 'result', text, isError: false };
  },
};

export default gemini;
