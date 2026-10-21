import type { Category, Tier } from './types.ts';

/** Default delegation levels. Empty agents = automatic by role/category. */
export const DEFAULT_TIERS: Tier[] = [
  { id: 'coder-chief', label: 'Coder Chief', role: 'coder', category: 'feature', when: 'complex or vital logic that must not fail', agents: [], review: true, enabled: true },
  { id: 'coder-major', label: 'Coder Major', role: 'coder', category: 'feature', when: 'medium work that follows the existing design, with a low chance of error', agents: [], review: true, enabled: true },
  { id: 'coder-minor', label: 'Coder Minor', role: 'coder', category: 'small-change', when: 'small, bounded, mechanical edits with no logic (rename, copy text, config value)', agents: [], review: true, enabled: true },
  { id: 'tester', label: 'Tester', role: 'tester', category: 'tests', when: 'writing tests', agents: [], review: true, enabled: true },
  { id: 'docs-writer', label: 'Docs Writer', role: 'docs', category: 'docs', when: 'docs', agents: [], review: true, enabled: true },
];

/** Category a tier gets when it was saved without one (settings written before tiers had it). */
export const CATEGORY_OF: Record<Tier['role'], Category> = { coder: 'feature', tester: 'tests', docs: 'docs' };

/** Tool names cannot contain '-' in a Claude Code permission rule. */
export const toolName = (id: string) => id.replace(/-/g, '_');

/** Planner's menu of enabled tiers; '' when none is enabled. */
export function tiersNote(tiers: Tier[]): string {
  return tiers.filter((t) => t.enabled).map((t) => `- ${t.id} (${t.role}): ${t.when}`).join('\n');
}
