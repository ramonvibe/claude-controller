import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './db.ts';
import { Engine } from './engine.ts';
import { loadAdapters } from './adapters/index.ts';
import { seedAgents } from './agents.ts';
import { createApp } from './http.ts';
import { Orchestrator, orqRoutes } from './orchestrator.ts';
import { providerRoutes, registerProviders } from './openai.ts';
import { connectRoutes } from './connect.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = process.env.CC_DATA ?? `${root}data`;
const store = new Store(dataDir);
const engine = new Engine(store, await loadAdapters(), dataDir);
seedAgents(store);
registerProviders(store, engine);

const orch = new Orchestrator(store, engine, dataDir);
const token = randomBytes(24).toString('hex');
const app = createApp({ store, engine, token, staticDir: `${root}dist`, extraRoutes: [...orqRoutes(orch), ...providerRoutes(store, engine), ...connectRoutes(store, engine)] });
const port = await app.listen(Number(process.env.CC_PORT ?? 7777));
orch.endpoint = { url: `http://127.0.0.1:${port}`, token };
console.log(`Claude Controller: http://127.0.0.1:${port}`);
