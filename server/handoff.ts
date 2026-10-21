import { z } from 'zod';
import { CATEGORIES } from './types.ts';

export const Handoff = z.object({
  task_id: z.string(),
  role: z.enum(['coder', 'tester', 'docs']),
  category: z.enum(CATEGORIES),
  goal: z.string(),
  files: z.array(z.string()),
  context: z.string(),
  interfaces: z.string(),
  steps: z.array(z.string()),
  acceptance: z.array(z.string()),
  constraints: z.array(z.string()),
  sensitive: z.boolean(),
  tier: z.string().optional(),
});
export type Handoff = z.infer<typeof Handoff>;

export const Plan = z.object({ summary: z.string(), tasks: z.array(Handoff).min(1) });
export type Plan = z.infer<typeof Plan>;

export const Result = z.object({
  task_id: z.string(),
  status: z.enum(['done', 'blocked', 'failed']),
  summary: z.string(),
  files_changed: z.array(z.string()),
  checks: z.array(z.object({ cmd: z.string(), ok: z.boolean() })),
  questions: z.array(z.string()),
});
export type Result = z.infer<typeof Result>;

// The CLI's validator does not know the draft 2020-12 meta-schema that zod emits as "$schema".
const cliSchema = (t: z.ZodType) => {
  const { $schema, ...rest } = z.toJSONSchema(t);
  return rest;
};
export const planSchema = cliSchema(Plan);
export const resultSchema = cliSchema(Result);

/** First balanced {...} block in free text (providers without --json-schema). */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function parseStructured<T>(schema: z.ZodType<T>, structured: unknown, text: string): T | null {
  for (const candidate of [structured, extractJson(text)]) {
    const r = schema.safeParse(candidate);
    if (r.success) return r.data;
  }
  return null;
}

/** Executor output, tolerant: unparseable text becomes a summary. */
export function toResult(taskId: string, structured: unknown, text: string, isError: boolean): Result {
  const parsed = parseStructured(Result, structured, text);
  if (parsed) return { ...parsed, task_id: taskId };
  return {
    task_id: taskId,
    status: isError ? 'failed' : 'done',
    summary: text.slice(0, 600),
    files_changed: [],
    checks: [],
    questions: [],
  };
}

/** Rough token count used for handoff size display and estimated usage: ~4 chars per token. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
