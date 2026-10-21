// Skills = SKILL.md files from Claude Code (user, plugins, workspace). Their text is appended to an agent's system
// prompt, so the same skill works for Claude, DeepSeek, Gemini and API models alike.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { estimateTokens } from './handoff.ts';

export type Skill = { id: string; name: string; description: string; source: string; tokens: number; body: string };

const dirs = (p: string) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);

function parse(file: string, source: string): Skill | null {
  const text = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const front = m?.[1] ?? '';
  const body = (m?.[2] ?? text).trim();
  const field = (k: string) => new RegExp(`^${k}:\\s*["']?(.*?)["']?\\s*$`, 'm').exec(front)?.[1] ?? '';
  const name = field('name') || file.split('/').at(-2)!;
  return { id: `${source}:${name}`, name, description: field('description').slice(0, 300), source, tokens: estimateTokens(body), body };
}

function collect(root: string, source: string, out: Skill[]) {
  for (const d of dirs(root)) {
    const f = join(root, d, 'SKILL.md');
    if (existsSync(f)) {
      const s = parse(f, source);
      if (s) out.push(s);
    }
  }
}

/** Every installed skill. Plugins: only the newest cached version of each plugin. */
export function listSkills(workspace: string | null, home = homedir()): Skill[] {
  const out: Skill[] = [];
  collect(join(home, '.claude', 'skills'), 'usuário', out);
  const cache = join(home, '.claude', 'plugins', 'cache');
  for (const market of dirs(cache))
    for (const plugin of dirs(join(cache, market))) {
      const versions = dirs(join(cache, market, plugin)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      if (!versions.length) continue;
      const base = join(cache, market, plugin, versions[0]);
      collect(join(base, 'skills'), plugin, out);
      collect(join(base, '.claude', 'skills'), plugin, out);
    }
  if (workspace) collect(join(workspace, '.claude', 'skills'), 'projeto', out);
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.id) && seen.add(s.id)).sort((a, b) => a.id.localeCompare(b.id));
}

/** Text appended to the system prompt for the chosen skill ids (unknown ids are skipped). */
export function skillsPrompt(ids: string[], all: Skill[]): string {
  const chosen = ids.map((id) => all.find((s) => s.id === id)).filter((s): s is Skill => Boolean(s));
  return chosen.map((s) => `\n\n# Skill: ${s.name}\n${s.body}`).join('');
}
