import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import type { Store } from './db.ts';
import type { Engine } from './engine.ts';
import { newId } from './engine.ts';
import { parseAgent } from './agents.ts';
import { CATEGORIES } from './types.ts';
import { CLI_TIERS } from './catalog.ts';
import { listSkills } from './skills.ts';

export type Ctx = { store: Store; engine: Engine; token: string; staticDir: string; extraRoutes?: Route[] };
export type Route = [method: string, path: RegExp, handler: (req: Req) => Promise<unknown> | unknown];
export type Req = { params: string[]; body: any; query: URLSearchParams };

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}
export const httpError = (status: number, msg: string) => new HttpError(status, msg);

const SettingsInput = z.object({
  workspace: z.string().min(1).nullable(),
  testCommands: z.array(z.string().min(1).max(200)).max(20),
  parallel: z.boolean(),
  mode: z.enum(['pipeline', 'agent']),
  routing: z.partialRecord(z.enum(CATEGORIES), z.array(z.string()).max(5)).default({}),
  skills: z.array(z.string().max(300)).max(50).default([]),
  review: z.partialRecord(z.enum(CATEGORIES), z.boolean()).default({ docs: false }),
  repoMap: z.string().nullable().default(null),
});

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw httpError(413, 'corpo muito grande');
    chunks.push(c);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw httpError(400, 'JSON inválido');
  }
}

export function createApp(ctx: Ctx) {
  const { store, engine } = ctx;
  const providers = () => new Set(engine.adapters.keys());

  const routes: Route[] = [
    ['GET', /^\/api\/state$/, () => ({
      agents: store.agents(),
      settings: store.settings(),
      providers: [...engine.adapters.values()].map((a) => ({ id: a.id, label: a.label, models: a.models, external: a.external, tier: a.tier ?? CLI_TIERS[a.id]?.tier ?? null, modelTiers: a.modelTiers ?? {} })),
      live: store.liveState(),
      usage: store.usageTotals(),
      rateLimit: engine.lastRateLimit,
    })],
    ['POST', /^\/api\/agents$/, ({ body }) => {
      const a = parseAgent(body, undefined, providers());
      store.saveAgent(a);
      store.emit({ runId: null, taskId: null, agentId: a.id, kind: 'agents_changed', payload: null });
      return a;
    }],
    ['PUT', /^\/api\/agents\/([\w-]+)$/, ({ params, body }) => {
      if (!store.agent(params[0])) throw httpError(404, 'agente não encontrado');
      const a = parseAgent(body, params[0], providers());
      store.saveAgent(a);
      store.emit({ runId: null, taskId: null, agentId: a.id, kind: 'agents_changed', payload: null });
      return a;
    }],
    ['DELETE', /^\/api\/agents\/([\w-]+)$/, ({ params }) => {
      store.deleteAgent(params[0]);
      store.emit({ runId: null, taskId: null, agentId: params[0], kind: 'agents_changed', payload: null });
      return { ok: true };
    }],
    ['PUT', /^\/api\/settings$/, ({ body }) => {
      const s = SettingsInput.parse(body);
      if (s.workspace && !statSync(s.workspace, { throwIfNoEntry: false })?.isDirectory())
        throw httpError(400, `Workspace não existe ou não é um diretório: ${s.workspace}`);
      store.saveSettings(s);
      return s;
    }],
    // Single-agent task: runs in background, progress arrives over the WebSocket.
    ['POST', /^\/api\/tasks$/, ({ body }) => {
      const { agentId, prompt } = z.object({ agentId: z.string(), prompt: z.string().min(1).max(100_000) }).parse(body);
      const agent = store.agent(agentId);
      if (!agent) throw httpError(404, 'agente não encontrado');
      engine.workspace(); // fail fast, before creating the run
      const runId = newId();
      store.createRun(runId, prompt, 'single');
      engine.execute({ runId, agent, prompt }).then((r) => store.endRun(runId, r.ok ? 'done' : 'error', { taskId: r.taskId }));
      return { runId };
    }],
    ['POST', /^\/api\/tasks\/([\w-]+)\/cancel$/, ({ params }) => ({ cancelled: engine.cancel(params[0]) })],
    ['GET', /^\/api\/runs$/, () => store.runs()],
    ['GET', /^\/api\/runs\/([\w-]+)$/, ({ params }) => store.run(params[0]) ?? Promise.reject(httpError(404, 'run não encontrado'))],
    ['GET', /^\/api\/skills$/, () => listSkills(store.settings().workspace).map(({ body, ...s }) => s)],
    ['GET', /^\/api\/diagnostics$/, ({ query }) => engine.diagnostics(query.has('refresh'))],
    ['GET', /^\/api\/tasks\/([\w-]+)\/events$/, ({ params }) =>
      store.db.prepare('select * from events where task_id=? order by id').all(params[0])],
    ...(ctx.extraRoutes ?? []),
  ];

  let port = 0;
  const hostOk = (host?: string) => host === `127.0.0.1:${port}` || host === `localhost:${port}`;

  async function serveStatic(path: string, res: ServerResponse) {
    const file = normalize(join(ctx.staticDir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(ctx.staticDir)) throw httpError(403, 'proibido');
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      if (extname(path)) throw httpError(404, 'não encontrado');
      data = await readFile(join(ctx.staticDir, 'index.html')).catch(() => {
        throw httpError(500, 'UI não compilada: rode npm start');
      });
    }
    const type = TYPES[extname(file)] ?? 'text/html';
    // The token reaches the page only through same-origin HTML; other sites cannot read it.
    const body = type === 'text/html' ? data.toString().replace('</head>', `<meta name="cc-token" content="${ctx.token}"></head>`) : data;
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  }

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only our own loopback authority.
      if (!hostOk(req.headers.host)) throw httpError(421, 'host não permitido');
      const url = new URL(req.url ?? '/', 'http://x');
      if (!url.pathname.startsWith('/api/')) return await serveStatic(url.pathname, res);
      if (!same(String(req.headers['x-token'] ?? ''), ctx.token)) throw httpError(401, 'token inválido');
      for (const [method, re, handler] of routes) {
        const m = re.exec(url.pathname);
        if (!m || method !== req.method) continue;
        const out = await handler({ params: m.slice(1), body: await readBody(req), query: url.searchParams });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? null));
        return;
      }
      throw httpError(404, 'rota não encontrada');
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : e instanceof z.ZodError ? 400 : typeof e?.status === 'number' ? e.status : 500;
      const message = e instanceof z.ZodError ? z.prettifyError(e) : (e?.message ?? String(e));
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    const originOk = !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
    if (url.pathname !== '/ws' || !hostOk(req.headers.host) || !originOk || !same(url.searchParams.get('token') ?? '', ctx.token)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  store.bus.on('event', (ev) => {
    const msg = JSON.stringify(ev);
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  });

  return {
    server,
    listen(p: number) {
      return new Promise<number>((res) =>
        server.listen(p, '127.0.0.1', () => {
          port = (server.address() as any).port;
          res(port);
        }),
      );
    },
    close() {
      for (const c of wss.clients) c.terminate();
      return new Promise((r) => server.close(r));
    },
  };
}
