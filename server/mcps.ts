import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type McpServerSpec =
  | { type?: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export type McpPreset = {
  id: string;
  label: string;
  kind: 'mcp' | 'rules'; // rules = a built-in tool allowlist, no MCP server
  providers: string[];
  rules?: string[];
  server?: () => McpServerSpec | null; // null = unavailable (missing env)
};

export const PRESETS: McpPreset[] = [
  { id: 'git-read', label: 'Git (leitura)', kind: 'rules', providers: ['claude-cli'], rules: ['git diff', 'git status', 'git log'].flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]) },
  { id: 'read-edit', label: 'Leitura/edição', kind: 'rules', providers: ['claude-cli'], rules: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] },
  { id: 'web-fetch', label: 'Fetch/web', kind: 'rules', providers: ['claude-cli'], rules: ['WebFetch'] },
  {
    id: 'context7',
    label: 'Docs de bibliotecas (Context7)',
    kind: 'mcp',
    providers: ['claude-cli'],
    server: () => ({ command: 'npx', args: ['-y', '@upstash/context7-mcp@4.4.4'] }),
  },
  {
    id: 'playwright',
    label: 'Navegador (Playwright)',
    kind: 'mcp',
    providers: ['claude-cli'],
    server: () => ({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--headless'] }),
  },
  {
    id: 'github',
    label: 'GitHub',
    kind: 'mcp',
    providers: ['claude-cli'],
    // Token stays in the backend environment; it only reaches the per-task config file (0600).
    server: () =>
      process.env.GITHUB_TOKEN
        ? { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } }
        : null,
  },
];

export const ORQ_ENTRY = fileURLToPath(new URL('../mcp/orq.ts', import.meta.url));

export function orqServer(url: string, token: string, runId: string): McpServerSpec {
  return { command: process.execPath, args: [ORQ_ENTRY], env: { ORQ_URL: url, ORQ_TOKEN: token, ORQ_RUN_ID: runId } };
}

/** Permission rules and MCP servers for a set of preset ids (+ extra servers such as orq). */
export function resolveMcps(ids: string[], extra: Record<string, McpServerSpec> = {}) {
  const rules: string[] = [];
  const servers: Record<string, McpServerSpec> = { ...extra };
  const missing: string[] = [];
  for (const id of ids) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) continue;
    if (p.rules) rules.push(...p.rules);
    if (p.server) {
      const s = p.server();
      if (s) servers[p.id] = s;
      else missing.push(p.id);
    }
  }
  for (const name of Object.keys(servers)) rules.push(`mcp__${name}`);
  return { rules, servers, missing };
}

/** Write a --mcp-config file readable only by the user; caller removes it after the task. */
export function writeMcpConfig(dir: string, name: string, servers: Record<string, McpServerSpec>) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
  return { path, remove: () => rmSync(path, { force: true }) };
}
