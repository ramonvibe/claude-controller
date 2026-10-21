#!/usr/bin/env node
// Stand-in for gemini-cli login: answers like the real headless flow (consent on stdin, then xdg-open the URL).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.65.0');
  process.exit(0);
}
process.stdout.write('Opening authentication page in your browser. Do you want to continue? [Y/n]: ');
const answer = fs.readFileSync(0, 'utf8').trim().toLowerCase();
if (!['y', ''].includes(answer)) process.exit(41);
if (!args.includes('--skip-trust')) process.exit(55);
execFileSync('xdg-open', ['https://accounts.google.com/o/oauth2/v2/auth?client_id=fake']);
fs.mkdirSync(`${process.env.HOME}/.gemini`, { recursive: true });
fs.writeFileSync(`${process.env.HOME}/.gemini/oauth_creds.json`, '{}');
console.log('{"response":"ok"}');
