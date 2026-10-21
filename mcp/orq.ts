// MCP server "orq" (stdio). Spawned by Claude Code from a per-task --mcp-config file;
// every tool is a thin call to the Claude Controller backend, which owns routing.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Handoff } from '../server/handoff.ts';

const { ORQ_URL, ORQ_TOKEN, ORQ_RUN_ID } = process.env;
if (!ORQ_URL || !ORQ_TOKEN || !ORQ_RUN_ID) {
  console.error('orq: ORQ_URL, ORQ_TOKEN e ORQ_RUN_ID são obrigatórios');
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(ORQ_URL + path, {
    method,
    headers: { 'x-token': ORQ_TOKEN!, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] });
const run = encodeURIComponent(ORQ_RUN_ID);

const server = new McpServer({ name: 'orq', version: '0.1.0' });

server.registerTool(
  'delegate_task',
  {
    description:
      'Send one self-contained handoff to the agent of the right role (coder, tester, docs). Blocks until it is done, reviewed, and returns only a compact result {task_id,status,summary,files_changed,checks,questions}.',
    inputSchema: { handoff: Handoff },
  },
  async ({ handoff }) => text(await call('POST', `/api/orq/${run}/delegate`, { handoff })),
);

// One tool per tier: the tier fixes role and category, so the caller only writes the handoff body.
// A tiers fetch failure must not kill the server: start with the fixed tools only.
const tiers = await call('GET', `/api/orq/${run}/tiers`).catch((e) => (console.error('orq: tiers fetch failed:', e.message), []));
for (const t of tiers) {
  server.registerTool(
    t.tool,
    {
      description: `${t.label}: ${t.hint}. Runs on: ${t.agents.join(', ') || 'automatic by role'}. Blocks until done and reviewed; returns compact result.`,
      inputSchema: { handoff: Handoff.omit({ role: true, tier: true }) },
    },
    async ({ handoff }) => text(await call('POST', `/api/orq/${run}/delegate`, { handoff: { ...handoff, role: t.role, tier: t.id } })),
  );
}

server.registerTool(
  'task_status',
  { description: 'Compact result of a task already delegated in this run.', inputSchema: { task_id: z.string() } },
  async ({ task_id }) => text(await call('GET', `/api/orq/${run}/tasks/${encodeURIComponent(task_id)}`)),
);

server.registerTool('list_agents', { description: 'Enabled agents: role, model, provider.', inputSchema: {} }, async () =>
  text(await call('GET', `/api/orq/${run}/agents`)),
);

server.registerTool('notes_read', { description: 'Shared notes of this run.', inputSchema: {} }, async () =>
  text(await call('GET', `/api/orq/${run}/notes`)),
);

server.registerTool(
  'notes_write',
  { description: 'Append a short fact to the shared notes of this run (agents read it instead of receiving it again).', inputSchema: { text: z.string().max(2000) } },
  async ({ text: note }) => text(await call('POST', `/api/orq/${run}/notes`, { text: note })),
);

await server.connect(new StdioServerTransport());
