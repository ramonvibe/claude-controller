import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Adapter, Detect } from './types.ts';
import { CATALOG } from './catalog.ts';
import { sandboxFromRules, toolLoop } from './toolloop.ts';
import type { Store } from './db.ts';
import type { Engine } from './engine.ts';
import { newId } from './engine.ts';
import { httpError, type Route } from './http.ts';

const ENV_FILE = process.env.CC_ENV_FILE ?? fileURLToPath(new URL('../.env', import.meta.url));

/** Keys live in the backend environment or the local .env (re-read on every call, so edits need no restart). */
export function getKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  try {
    return parseEnv(readFileSync(ENV_FILE, 'utf8'))[name];
  } catch {
    return undefined;
  }
}

export const ProviderInput = z.object({
  catalog: z.string(),
  label: z.string().min(1).max(60),
  baseUrl: z.url().refine((u) => /^https?:\/\//.test(u), 'URL http(s)'),
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'nome de variável em MAIÚSCULAS'),
  models: z.array(z.object({ id: z.string().min(1).max(200), free: z.boolean(), tools: z.boolean().nullable().optional() })).max(200),
});
export type ProviderConfig = z.infer<typeof ProviderInput> & { id: string };

const chatUrl = (base: string) => base.replace(/\/+$/, '') + '/chat/completions';
const headers = (p: ProviderConfig) => {
  const key = getKey(p.keyEnv);
  const h: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  if (p.catalog === 'openrouter') h['x-title'] = 'Claude Controller';
  return h;
};

export function makeOpenAIAdapter(p: ProviderConfig): Adapter {
  const tier = CATALOG.find((c) => c.id === p.catalog)?.tier ?? 'paga';
  return {
    id: p.id,
    label: p.label,
    external: true,
    models: p.models.map((m) => m.id),
    supportsSchema: false,
    tier,
    modelTiers: Object.fromEntries(p.models.map((m) => [m.id, m.free ? 'free' : 'paga'])),
    async detect(): Promise<Detect> {
      const key = getKey(p.keyEnv);
      if (!key) return { ok: false, version: null, auth: 'não autenticado', detail: `defina ${p.keyEnv} no arquivo .env`, capabilities: {} };
      try {
        const r = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', { headers: headers(p), signal: AbortSignal.timeout(15000) });
        return { ok: r.ok, version: null, auth: r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'não autenticado' : 'desconhecido', detail: `GET /models → HTTP ${r.status}`, capabilities: {} };
      } catch (e: any) {
        return { ok: false, version: null, auth: 'desconhecido', detail: e.message, capabilities: {} };
      }
    },
    async *run(i) {
      if (!getKey(p.keyEnv)) {
        yield { kind: 'error', message: `chave ausente: defina ${p.keyEnv} no .env`, code: 'MISSING_CREDENTIAL' };
        return;
      }
      const timeout = AbortSignal.any([i.signal, AbortSignal.timeout(i.agent.limits.timeoutSec * 1000)]);
      yield* toolLoop({
        url: chatUrl(p.baseUrl),
        headers: headers(p),
        model: i.agent.model,
        systemPrompt: i.systemPrompt,
        prompt: i.prompt,
        sandbox: sandboxFromRules(i.cwd, i.rules),
        signal: timeout,
        free: p.models.find((m) => m.id === i.agent.model)?.free,
        extraBody: p.catalog === 'openrouter' ? { usage: { include: true } } : undefined,
      });
    },
  };
}

/** List models of a provider; OpenRouter marks free ones by price 0 or the ":free" suffix. */
async function remoteModels(p: Omit<ProviderConfig, 'id' | 'models' | 'label'>) {
  const r = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', { headers: headers(p as ProviderConfig), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw httpError(502, `GET /models → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const list: any[] = j.data ?? j.models ?? [];
  const tier = CATALOG.find((c) => c.id === p.catalog)?.tier;
  return list
    .map((m) => {
      const id = String(m.id ?? m.name ?? '').replace(/^models\//, '');
      const priced = m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0;
      // OpenRouter lists supported_parameters; the tool loop needs "tools". Unknown elsewhere (null).
      const tools = Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null;
      return { id, free: tier === 'free' || id.endsWith(':free') || Boolean(priced), tools };
    })
    .filter((m) => m.id)
    .sort((a, b) => Number(b.free) - Number(a.free) || Number(b.tools !== false) - Number(a.tools !== false) || a.id.localeCompare(b.id));
}

export function registerProviders(store: Store, engine: Engine) {
  for (const p of store.providers()) engine.adapters.set(p.id, makeOpenAIAdapter(p));
}

export function providerRoutes(store: Store, engine: Engine): Route[] {
  const changed = () => store.emit({ runId: null, taskId: null, agentId: null, kind: 'agents_changed', payload: null });
  return [
    ['GET', /^\/api\/catalog$/, () => CATALOG.map(({ id, label, tier, kind, baseUrl, keyEnv, keyUrl, note }) => ({ id, label, tier, kind, baseUrl, keyEnv, keyUrl, note, keySet: keyEnv ? Boolean(getKey(keyEnv)) : null }))],
    ['GET', /^\/api\/providers$/, () => store.providers().map((p) => ({ ...p, keySet: Boolean(getKey(p.keyEnv)) }))],
    ['POST', /^\/api\/providers\/models$/, ({ body }) => remoteModels(ProviderInput.pick({ catalog: true, baseUrl: true, keyEnv: true }).parse(body))],
    ['POST', /^\/api\/providers$/, ({ body }) => {
      const p = { id: `api-${newId()}`, ...ProviderInput.parse(body) };
      store.saveProvider(p);
      engine.adapters.set(p.id, makeOpenAIAdapter(p));
      changed();
      return p;
    }],
    ['PUT', /^\/api\/providers\/([\w-]+)$/, ({ params, body }) => {
      if (!store.providers().some((x) => x.id === params[0])) throw httpError(404, 'provedor não encontrado');
      const p = { id: params[0], ...ProviderInput.parse(body) };
      store.saveProvider(p);
      engine.adapters.set(p.id, makeOpenAIAdapter(p));
      changed();
      return p;
    }],
    ['DELETE', /^\/api\/providers\/([\w-]+)$/, ({ params }) => {
      if (store.agents().some((a) => a.provider === params[0])) throw httpError(400, 'Há cards usando este provedor; troque o modelo deles antes.');
      store.deleteProvider(params[0]);
      engine.adapters.delete(params[0]);
      changed();
      return { ok: true };
    }],
  ];
}
