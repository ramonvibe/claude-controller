import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
chmodSync(FAKE, 0o755);
process.env.CLAUDE_BIN = FAKE;

export function tmp() {
  return mkdtempSync(join(tmpdir(), 'cc-test-'));
}

/** Point the fake CLI at a fresh script; returns the log file of its invocations. */
export function fakeScript(steps: unknown[]) {
  const dir = tmp();
  const script = join(dir, 'script.json');
  writeFileSync(script, JSON.stringify(steps));
  process.env.FAKE_SCRIPT = script;
  process.env.FAKE_LOG = join(dir, 'log.ndjson');
  return process.env.FAKE_LOG;
}

export async function startApp() {
  const { Store } = await import('../server/db.ts');
  const { Engine } = await import('../server/engine.ts');
  const { loadAdapters } = await import('../server/adapters/index.ts');
  const { seedAgents } = await import('../server/agents.ts');
  const { createApp } = await import('../server/http.ts');
  const { Orchestrator, orqRoutes } = await import('../server/orchestrator.ts');
  const dir = tmp();
  const ws = join(dir, 'workspace');
  mkdirSync(ws);
  const store = new Store(join(dir, 'data'));
  const engine = new Engine(store, await loadAdapters());
  seedAgents(store);
  store.saveSettings({ ...store.settings(), workspace: ws });
  const staticDir = join(dir, 'dist');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<html><head></head><body>ui</body></html>');
  const orch = new Orchestrator(store, engine, dir);
  const app = createApp({ store, engine, token: 'tok', staticDir, extraRoutes: orqRoutes(orch) });
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { 'x-token': 'tok', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
    return j;
  };
  return { store, engine, orch, app, base, port, api, ws, dir };
}

/** Collect WebSocket events until `until` returns true. */
export function collect(port: number, until: (evs: any[]) => boolean, timeoutMs = 15000): { ready: Promise<void>; done: Promise<any[]> } {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok`);
  const evs: any[] = [];
  const ready = new Promise<void>((r) => sock.on('open', () => r()));
  const done = new Promise<any[]>((res, rej) => {
    const t = setTimeout(() => {
      sock.close();
      rej(new Error('timeout: ' + JSON.stringify(evs.map((e) => e.kind))));
    }, timeoutMs);
    sock.on('message', (m) => {
      evs.push(JSON.parse(String(m)));
      if (until(evs)) {
        clearTimeout(t);
        sock.close();
        res(evs);
      }
    });
  });
  return { ready, done };
}
