import type { Role } from './types.ts';

/** Always denied, for every agent, on top of the dontAsk allowlist (DECISOES.md, decision 4). */
export const DENY = [
  'Bash(git commit)', 'Bash(git commit *)', 'Bash(git push)', 'Bash(git push *)',
  'Bash(rm -r *)', 'Bash(rm -rf *)', 'Bash(rm -fr *)', 'Bash(rm -R *)',
  'Read(**/.env*)', 'Edit(**/.env*)', 'Read(**/*.pem)', 'Read(**/*.key)',
];

const GIT_READ = ['git diff', 'git status', 'git log'].flatMap(bashRule);
const READ = ['Read', 'Grep', 'Glob'];
const EDIT = ['Edit', 'Write'];

function bashRule(cmd: string) {
  return [`Bash(${cmd})`, `Bash(${cmd} *)`];
}

export function roleRules(role: Role, testCommands: string[]): string[] {
  const tests = testCommands.flatMap(bashRule);
  switch (role) {
    case 'planner': return [...READ, ...GIT_READ];
    case 'coder':
    case 'tester': return [...READ, ...EDIT, ...tests, ...GIT_READ];
    case 'reviewer': return [...READ, ...tests, ...GIT_READ];
    case 'docs': return [...READ, ...EDIT, ...GIT_READ];
    case 'custom': return [...READ];
  }
}

/** Built-in tool names for `--tools`, derived from permission rules (MCP tools come from --mcp-config). */
export function toolNames(rules: string[]): string[] {
  return [...new Set(rules.map((r) => r.split('(')[0]).filter((n) => !n.startsWith('mcp__')))];
}

const EXECUTOR = `You receive one task handoff as JSON. You have never seen the conversation that produced it; the handoff is all the context you get.
Do exactly the task. Do not touch files outside "files" unless strictly required. Read the files you need yourself.
Run the acceptance commands you are allowed to run. Never commit or push.
Reply ONLY with a JSON object: {"task_id","status":"done|blocked|failed","summary":"<=5 lines","files_changed":[],"checks":[{"cmd","ok"}],"questions":[]}.
Use "blocked" when the spec is ambiguous or impossible, and say why in "questions".`;

export const TEMPLATES: Record<Role, string> = {
  planner: `You are the planner of a team of cheaper coding agents. Read only what you need from the repository.
Output a JSON plan: {"summary","tasks":[handoff...]}. Each handoff is self-contained for an agent that has never seen this request:
file paths (not file contents), exact interfaces, steps, acceptance criteria that are runnable commands, constraints.
Keep each handoff under 400 tokens. No conversation history, no justification of the plan.
Roles: "coder" writes code, "tester" writes tests, "docs" writes documentation.
Category (decides which model runs it, cheapest first, so be honest):
"architecture" = design decisions or cross-cutting changes needing deep reasoning; "feature" = normal code following an existing design;
"small-change" = small, low-risk edits (rename, copy text, style, config value); "tests" = writing tests; "docs" = README and docs.
Set "sensitive": true for anything touching secrets, auth or personal data. Do not edit files yourself.
Order tasks so that later ones may depend on earlier ones.`,
  coder: `You are a coder. ${EXECUTOR}`,
  tester: `You are a test writer. Write or fix tests only. ${EXECUTOR}`,
  docs: `You are a documentation writer. Edit documentation only. ${EXECUTOR}`,
  reviewer: `You review one finished task. You get the handoff and the executor's summary.
Inspect the change with git diff on the listed files and run the acceptance commands you are allowed to run.
Reply ONLY with a JSON object: {"task_id","status":"done|failed","summary":"<=5 lines","files_changed":[],"checks":[{"cmd","ok"}],"questions":[]}.
"done" means every acceptance criterion holds. "failed" means it does not; the summary says exactly what to fix.`,
  custom: `You are a helpful coding agent. Be concise.`,
};

export const AGENT_MODE_PLANNER = `You are the planner of a team of cheaper coding agents. Read only what you need from the repository.
Delegate each subtask with the orq "delegate_task" tool, one self-contained handoff at a time
(file paths not contents, exact interfaces, runnable acceptance commands, constraints, under 400 tokens).
Use "notes_write" for facts several agents need. Do not edit files yourself.
When everything is done, reply with a summary of at most 5 lines.`;

/** Appended to every system prompt: agents only know which shell commands will pass the allowlist if told. */
export function commandsNote(testCommands: string[]) {
  const cmds = [...testCommands, 'git diff', 'git status', 'git log'].map((c) => `\`${c}\``).join(', ');
  return `\n\nShell commands that are allowed (cwd is already the repository root; no cd, no pipes, no other commands): ${cmds}. Acceptance criteria must be checkable with exactly these commands or by reading files.`;
}
