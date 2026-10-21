import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './db.ts';
import { Engine } from './engine.ts';
import { loadAdapters } from './adapters/index.ts';
import { seedAgents } from './agents.ts';
import { createApp } from './http.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const store = new Store(process.env.CC_DATA ?? `${root}data`);
const engine = new Engine(store, await loadAdapters());
seedAgents(store);

const app = createApp({ store, engine, token: randomBytes(24).toString('hex'), staticDir: `${root}dist` });
const port = await app.listen(Number(process.env.CC_PORT ?? 7777));
console.log(`Claude Controller: http://127.0.0.1:${port}`);
