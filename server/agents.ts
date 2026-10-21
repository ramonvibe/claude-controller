import { z } from 'zod';
import { ROLES } from './types.ts';
import type { Agent } from './types.ts';
import type { Store } from './db.ts';
import { newId } from './engine.ts';

export const AgentInput = z.object({
  name: z.string().min(1).max(60),
  provider: z.string().min(1),
  model: z.string().min(1).max(100),
  role: z.enum(ROLES),
  systemPrompt: z.string().max(20000).nullable().default(null),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  tools: z.array(z.string().min(1).max(200)).nullable().default(null),
  mcps: z.array(z.string()).default([]),
  inheritUserConfig: z.boolean().default(false),
  limits: z
    .object({
      maxBudgetUsd: z.number().positive().nullable().default(null),
      maxReviewLoops: z.number().int().min(0).max(5).default(2),
      timeoutSec: z.number().int().min(10).max(3600).default(600),
    })
    .default({ maxBudgetUsd: null, maxReviewLoops: 2, timeoutSec: 600 }),
  enabled: z.boolean().default(true),
});

export function parseAgent(body: unknown, id = newId(), providers: Set<string>): Agent {
  const a = AgentInput.parse(body);
  if (!providers.has(a.provider)) throw new Error(`Provedor desconhecido: ${a.provider}`);
  return { id, ...a };
}

export function seedAgents(store: Store) {
  if (store.agents().length) return;
  const base = { systemPrompt: null, tools: null, mcps: [], inheritUserConfig: false, enabled: true };
  const limits = { maxBudgetUsd: null, maxReviewLoops: 2, timeoutSec: 600 };
  const seed: Agent[] = [
    { id: newId(), name: 'Planejador', provider: 'claude-cli', model: 'opus', role: 'planner', effort: 'medium', limits, ...base },
    { id: newId(), name: 'Codificador', provider: 'claude-cli', model: 'haiku', role: 'coder', effort: null, limits, ...base },
    { id: newId(), name: 'Revisor', provider: 'claude-cli', model: 'haiku', role: 'reviewer', effort: null, limits, ...base },
    { id: newId(), name: 'Docs (DeepSeek)', provider: 'dsh', model: 'deepseek-flash', role: 'docs', effort: null, limits, ...base },
  ];
  for (const a of seed) store.saveAgent(a);
  const [planner, coder, , docs] = seed;
  store.saveSettings({
    ...store.settings(),
    routing: { architecture: [planner.id], feature: [coder.id], 'small-change': [coder.id], tests: [coder.id], docs: [docs.id, coder.id] },
  });
}
