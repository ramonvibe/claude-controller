// "Conectar" for providers that log in through the browser with their own tool (dsh web, gemini-cli).
// The app never sees the provider's credentials: it starts the provider's own login and waits for it to finish.
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { Store } from './db.ts';
import type { Engine } from './engine.ts';
import { capture } from './proc.ts';
import { CLI_TIERS } from './catalog.ts';
import { geminiCmd, GEMINI_ENV, geminiLoggedIn } from './adapters/gemini.ts';
import { httpError, type Route } from './http.ts';

const LOGIN_TIMEOUT = 10 * 60_000;
const URL_RE = /https?:\/\/[^\s"'<>]+/;

type Session = { child: ChildProcess; url: string | null; timer: NodeJS.Timeout; poll?: NodeJS.Timeout };

export function connectRoutes(store: Store, engine: Engine): Route[] {
  const sessions = new Map<string, Session>();
  const emit = (id: string, payload: object) => store.emit({ runId: null, taskId: null, agentId: null, kind: 'connect', payload: { id, ...payload } });

  const stop = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    clearInterval(s.poll);
    s.child.kill('SIGTERM');
    sessions.delete(id);
  };
  const done = (id: string, status: 'ok' | 'timeout' | 'error', detail = '') => {
    stop(id);
    engine.diagnostics(true); // refresh cached detection so cards and Diagnóstico see the new state
    emit(id, { status, detail });
  };

  function launch(id: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, onLine: (line: string, s: Session) => void, onExit: (code: number | null) => void) {
    stop(id);
    const child = spawn(cmd, args, { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const s: Session = { child, url: null, timer: setTimeout(() => done(id, 'timeout', 'login não concluído em 10 minutos'), LOGIN_TIMEOUT) };
    sessions.set(id, s);
    const read = (d: Buffer) => String(d).split('\n').forEach((l) => l.trim() && onLine(l, s));
    child.stdout!.on('data', read);
    child.stderr!.on('data', read);
    child.on('error', (e) => done(id, 'error', e.message));
    child.on('exit', (code) => sessions.get(id)?.child === child && onExit(code));
    return s;
  }

  const starters: Record<string, () => Promise<{ url: string | null; message: string }>> = {
    // dsh web serves its own page with the DeepSeek/Google login; headless reuses that login afterwards.
    dsh: () =>
      new Promise((res) => {
        const s = launch('dsh', process.env.DSH_BIN ?? 'dsh', ['--profile', 'web', '--no-open', '--port', '0'], process.env, (line, sess) => {
          const m = /dsh web: (\S+)/.exec(line);
          if (m && !sess.url) {
            sess.url = m[1];
            emit('dsh', { status: 'waiting', url: sess.url });
            res({ url: sess.url, message: 'Faça login na página do DeepSeek que abriu; o app confere sozinho a cada 20 s.' });
            sess.poll = setInterval(async () => {
              const d = await engine.adapters.get('dsh')?.detect();
              if (d?.auth === 'ok') done('dsh', 'ok');
            }, 20_000);
          }
        }, (code) => done('dsh', 'error', `dsh web saiu (código ${code})`));
        setTimeout(() => !s.url && res({ url: null, message: 'dsh web não informou a URL; veja Diagnóstico.' }), 15_000);
      }),
    // gemini-cli opens Google's login in the browser itself; a successful tiny prompt means the login is stored.
    'gemini-cli': async () => {
      const [cmd, pre] = geminiCmd();
      launch('gemini-cli', cmd, [...pre, '-p', 'Reply with: ok', '-o', 'json'], GEMINI_ENV, (line, sess) => {
        const m = URL_RE.exec(line);
        if (m && /accounts\.google\.com|oauth/.test(m[0]) && !sess.url) {
          sess.url = m[0];
          emit('gemini-cli', { status: 'waiting', url: sess.url });
        }
      }, (code) => (code === 0 && geminiLoggedIn() ? done('gemini-cli', 'ok') : done('gemini-cli', 'error', `gemini saiu (código ${code}); se o navegador não abriu, rode "npx @google/gemini-cli" num terminal uma vez`)));
      return { url: null, message: 'A Gemini CLI vai abrir o login do Google no navegador. Conclua lá; o card muda sozinho.' };
    },
  };

  return [
    ['GET', /^\/api\/connect$/, async ({ query }) => {
      const diag = await engine.diagnostics(query.has('refresh'));
      return Object.entries(CLI_TIERS).map(([id, t]) => {
        const d: any = diag.find((x) => x.id === id);
        return { id, label: d?.label ?? id, tier: t.tier, loginNote: t.loginNote, installed: Boolean(d?.version), auth: d?.auth ?? 'desconhecido', detail: d?.detail ?? '', pending: sessions.has(id), url: sessions.get(id)?.url ?? null, canConnect: id in starters };
      });
    }],
    ['POST', /^\/api\/connect\/([\w-]+)$/, ({ params }) => {
      const start = starters[params[0]];
      if (!start) throw httpError(400, params[0] === 'claude-cli' ? 'Rode "claude auth login" num terminal.' : 'provedor sem login por navegador');
      return start();
    }],
    ['POST', /^\/api\/connect\/([\w-]+)\/stop$/, ({ params }) => {
      stop(params[0]);
      return { ok: true };
    }],
    ['POST', /^\/api\/connect\/gemini-cli\/install$/, async () => {
      const r = await capture('npm', ['i', '-g', '@google/gemini-cli@0.65.0'], 300_000);
      if (r.code !== 0) throw httpError(500, `npm falhou: ${r.err.slice(-300)}`);
      process.env.GEMINI_BIN ??= 'gemini';
      engine.diagnostics(true);
      return { ok: true };
    }],
  ];
}
