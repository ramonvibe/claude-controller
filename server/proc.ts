import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type ProcItem = { json: any } | { raw: string } | { exit: { code: number | null; stderr: string; aborted: boolean } };

/** Spawn a CLI, write `stdin`, yield each stdout line parsed as JSON, then one `exit` item. */
export async function* ndjson(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdin: string; signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv },
): AsyncGenerator<ProcItem> {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let aborted = false;
  const kill = () => {
    aborted = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  };
  if (opts.signal.aborted) kill();
  opts.signal.addEventListener('abort', kill, { once: true });
  const timer = setTimeout(kill, opts.timeoutMs);
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8000)));
  const closed = new Promise<number | null>((res) => {
    child.on('close', res);
    child.on('error', (e) => {
      stderr += String(e);
      res(null);
    });
  });
  child.stdin.on('error', () => {}); // child may exit before reading stdin
  child.stdin.end(opts.stdin);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      try {
        yield { json: JSON.parse(line) };
      } catch {
        yield { raw: line };
      }
    }
    yield { exit: { code: await closed, stderr, aborted } };
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', kill);
    if (child.exitCode === null) kill();
  }
}

/** Run a command to completion and capture output (for detection). */
export function capture(cmd: string, args: string[], timeoutMs = 20000, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env });
    let out = '';
    let err = '';
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('error', (e) => {
      clearTimeout(t);
      res({ code: null, out, err: String(e) });
    });
    c.on('close', (code) => {
      clearTimeout(t);
      res({ code, out, err });
    });
  });
}

/** HEAD of the workspace repo ('' when not a git repo): adapters without our allowlist detect commits by comparing it. */
export async function gitHead(cwd: string) {
  return (await capture('git', ['-C', cwd, 'rev-parse', '-q', 'HEAD'])).out.trim();
}

/**
 * Snapshot of the whole working tree (tracked + untracked, honoring .gitignore) as a git tree object, built in a
 * throwaway index: the user's index, branch and files are untouched. null when the workspace is not a git repo.
 */
export async function snapshotTree(cwd: string): Promise<string | null> {
  const { tmpdir } = await import('node:os');
  const { rmSync } = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  const idx = `${tmpdir()}/cc-idx-${randomUUID()}`;
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    if ((await capture('git', ['-C', cwd, 'rev-parse', '--git-dir'], 10000)).code !== 0) return null;
    await capture('git', ['-C', cwd, 'read-tree', 'HEAD'], 60000, env); // fails on an empty repo; add -A still works
    if ((await capture('git', ['-C', cwd, 'add', '-A'], 120000, env)).code !== 0) return null;
    const t = await capture('git', ['-C', cwd, 'write-tree'], 60000, env);
    return t.code === 0 ? t.out.trim() : null;
  } finally {
    rmSync(idx, { force: true });
  }
}
