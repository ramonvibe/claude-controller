import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ndjson, capture } from '../proc.ts';
import { estimateTokens } from '../handoff.ts';
import type { Adapter, AdapterEvent, Detect, RunInput } from '../types.ts';

const BIN = process.env.DSH_BIN ?? 'dsh';
const AUTH_CODES = new Set(['MISSING_CREDENTIAL', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID']);

/** Overlay that routes headless through the DeepSeek account login, like the web profile (DECISOES.md, fase 0). */
function accountPatch(model: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dsh-'));
  const path = join(dir, 'account.patch.yml');
  writeFileSync(
    path,
    // headless ships these three disabled; the account route needs all of them (DECISOES.md).
    [
      ['authorization', 'dsh-authorization'],
      ['credentials', 'dsh-credentials-local'],
      ['deepseek-account', 'dsh-deepseek-account-platform'],
    ].map(([id, pkg]) => `- id: ${id}\n  name: '@deepseek-ai/${pkg}'\n  disabled: false\n`).join('') +
      `- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: deepseek-account\n    model: ${JSON.stringify(model)}\n`,
  );
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Map one `dsh --json` event (fixtures/dsh/*.ndjson) to adapter events. */
export function mapDshEvent(o: any, model: string): AdapterEvent[] {
  const out: AdapterEvent[] = [];
  // Usage arrives on status/step_end (fixtures/dsh/ok-account.ndjson).
  const u = o?.usage;
  if (typeof u?.inputTokens === 'number' || typeof u?.outputTokens === 'number')
    out.push({ kind: 'usage', model, input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, cacheCreate: u.cacheWriteTokens ?? 0, costUsd: null, source: 'dsh-events' });
  switch (o?.type) {
    case 'session':
      out.push({ kind: 'status', text: `sessão ${o.sessionId}` });
      break;
    case 'status':
      if (o.phase === 'turn_end' && o.reason?.kind === 'error')
        out.push({ kind: 'error', message: o.reason.error?.message ?? 'erro no dsh', code: o.reason.error?.code });
      break;
    case 'text':
      if (o.text) out.push({ kind: 'delta', text: o.text });
      break;
    case 'final':
      if (o.text) out.push({ kind: 'result', text: o.text, isError: false });
      break;
  }
  return out;
}

const gitHead = async (cwd: string) => (await capture('git', ['-C', cwd, 'rev-parse', '-q', 'HEAD'])).out.trim();

const dsh: Adapter = {
  id: 'dsh',
  label: 'DeepSeek (dsh headless)',
  external: true,
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  supportsSchema: false,

  async detect(): Promise<Detect> {
    const v = await capture(BIN, ['--version']);
    if (v.code !== 0) return { ok: false, version: null, auth: 'desconhecido', detail: `dsh não encontrado: ${v.err.trim()}`, capabilities: {} };
    // Only a real call proves the headless profile can reach the account route.
    const patch = accountPatch('deepseek-flash');
    let auth: Detect['auth'] = 'desconhecido';
    let detail = '';
    try {
      for await (const item of ndjson(BIN, ['--profile', 'headless', '--patch', patch.path, '--json', '-'], {
        cwd: tmpdir(), stdin: 'Reply with: ok', signal: new AbortController().signal, timeoutMs: 60000,
      })) {
        if (!('json' in item)) continue;
        for (const ev of mapDshEvent(item.json, 'deepseek-flash')) {
          if (ev.kind === 'error') {
            auth = ev.code && AUTH_CODES.has(ev.code) ? 'não autenticado' : 'desconhecido';
            detail = `${ev.code ?? ''} ${ev.message}`.trim();
          } else if (ev.kind === 'result') auth = 'ok';
        }
      }
    } finally {
      patch.remove();
    }
    detail += `${detail ? ' · ' : ''}permissões: sandbox próprio do dsh (workspace-write); a allowlist do app não se aplica`;
    return { ok: auth === 'ok', version: v.out.trim(), auth, detail, capabilities: { '--json': true, '--patch': true } };
  },

  async *run(i: RunInput) {
    const patch = accountPatch(i.agent.model);
    const headBefore = await gitHead(i.cwd);
    let sawResult = false;
    let sawUsage = false;
    let text = '';
    // No system-prompt flag in headless: the role template travels in front of the task.
    const stdin = `${i.systemPrompt}\n\n---\n\n${i.prompt}`;
    try {
      for await (const item of ndjson(BIN, ['--profile', 'headless', '--patch', patch.path, '--json', '-'], {
        cwd: i.cwd, stdin, signal: i.signal, timeoutMs: i.agent.limits.timeoutSec * 1000,
      })) {
        if ('json' in item) {
          for (const ev of mapDshEvent(item.json, i.agent.model)) {
            if (ev.kind === 'result') {
              sawResult = true;
              text = ev.text;
              continue; // emitted after usage, below
            }
            if (ev.kind === 'usage') sawUsage = true;
            if (ev.kind === 'error') sawResult = true;
            yield ev;
          }
        } else if ('exit' in item && !sawResult) {
          const { code, stderr, aborted } = item.exit;
          yield { kind: 'error', message: aborted ? 'cancelado ou tempo esgotado' : stderr.trim().slice(-500) || `dsh saiu com código ${code}` };
        }
      }
      if (!text) return;
      if (!sawUsage)
        yield { kind: 'usage', model: i.agent.model, input: estimateTokens(stdin), output: estimateTokens(text), cacheRead: 0, cacheCreate: 0, costUsd: null, source: 'estimado' };
      // The dsh sandbox does not know decision 4: detect a commit instead of preventing it.
      if (headBefore && (await gitHead(i.cwd)) !== headBefore)
        yield { kind: 'error', message: 'o agente dsh criou um commit; revise com git log antes de continuar', code: 'COMMIT_FORBIDDEN' };
      else yield { kind: 'result', text, isError: false };
    } finally {
      patch.remove();
    }
  },
};

export default dsh;
