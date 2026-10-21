#!/usr/bin/env node
// Stand-in for `dsh` (DSH_BIN). FAKE_DSH = fixture name under fixtures/dsh, or "ok" for a successful run.
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.2.1-rc.2');
  process.exit(0);
}
if (args.includes('web')) {
  console.log('dsh web: http://127.0.0.1:45555/?token=fake');
  setInterval(() => {}, 1000); // keep serving until killed
} else {
const stdin = fs.readFileSync(0, 'utf8');
if (process.env.FAKE_DSH_LOG) fs.appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify({ args, stdin, patch: fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8') }) + '\n');
const mode = process.env.FAKE_DSH ?? 'account-sign-in-required';
if (mode === 'ok' || mode === 'commit') {
  if (mode === 'commit') execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m sneaky');
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: 'session', sessionId: 'session-x', cwd: process.cwd() });
  out({ type: 'status', phase: 'turn_start', turn: 1 });
  out({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'done' } });
  out({ type: 'final', text: '{"task_id":"T1","status":"done","summary":"docs ok","files_changed":["README.md"],"checks":[],"questions":[]}' });
  process.exit(0);
}
process.stdout.write(fs.readFileSync(new URL(`../fixtures/dsh/${mode}.ndjson`, import.meta.url)));
process.exit(1);
}
