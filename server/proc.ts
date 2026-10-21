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
export function capture(cmd: string, args: string[], timeoutMs = 20000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
