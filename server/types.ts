export type Role = 'planner' | 'coder' | 'reviewer' | 'tester' | 'docs' | 'custom';
export const ROLES: Role[] = ['planner', 'coder', 'reviewer', 'tester', 'docs', 'custom'];

export type Agent = {
  id: string;
  name: string;
  provider: string; // adapter id
  model: string;
  role: Role;
  systemPrompt: string | null; // null = role template
  effort: string | null;
  tools: string[] | null; // permission rules; null = role default
  mcps: string[]; // McpPreset ids
  inheritUserConfig: boolean;
  limits: { maxBudgetUsd: number | null; maxReviewLoops: number; timeoutSec: number };
  enabled: boolean;
};

export type Settings = {
  workspace: string | null;
  testCommands: string[];
  parallel: boolean;
  mode: 'pipeline' | 'agent';
};

export type Usage = {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  costUsd: number | null; // null = no price known
  source: 'claude-json' | 'dsh-events' | 'estimado';
};

/** Events an adapter yields while running one task. */
export type AdapterEvent =
  | { kind: 'status'; text: string }
  | { kind: 'delta'; text: string }
  | { kind: 'tool_use'; name: string; input: unknown }
  | { kind: 'rate_limit'; info: unknown }
  | ({ kind: 'usage' } & Usage)
  | { kind: 'result'; text: string; structured?: unknown; isError: boolean }
  | { kind: 'error'; message: string; code?: string };

export type RunInput = {
  agent: Agent;
  prompt: string;
  systemPrompt: string;
  rules: string[]; // allowed permission rules
  cwd: string;
  schema?: object;
  mcpConfigPath?: string;
  signal: AbortSignal;
};

export type Detect = {
  ok: boolean;
  version: string | null;
  auth: 'ok' | 'não autenticado' | 'desconhecido';
  detail: string;
  capabilities: Record<string, boolean>;
};

export type Adapter = {
  id: string;
  label: string;
  external: boolean; // non-Claude providers never get `sensitive` tasks
  models: string[];
  supportsSchema: boolean;
  detect(): Promise<Detect>;
  run(input: RunInput): AsyncIterable<AdapterEvent>;
};

/** Normalized event on the bus (persisted + broadcast). */
export type BusEvent = {
  id?: number;
  ts: number;
  runId: string | null;
  taskId: string | null;
  agentId: string | null;
  kind: AdapterEvent['kind'] | 'started' | 'handoff' | 'run_started' | 'run_done' | 'agents_changed';
  payload: any;
};
