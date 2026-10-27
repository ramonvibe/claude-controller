#!/usr/bin/env node
// `claude-app`: builds the page and starts the server, from any folder. Install with `npm link` in the clone.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
// Node refuses to run .ts files that live inside node_modules, which is where `npm i -g <repo>` copies them.
if (/[\\/]node_modules[\\/]/.test(root)) {
  console.error('claude-app: instale a partir do clone com "npm i && npm link" (não com "npm i -g").');
  process.exit(1);
}
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`claude-app: precisa do Node 24 ou mais novo (você tem ${process.version}).`);
  process.exit(1);
}
execFileSync(process.execPath, [`${root}/node_modules/vite/bin/vite.js`, 'build', 'web', '--emptyOutDir', '--logLevel', 'warn'], { cwd: root, stdio: 'inherit' });
await import('../server/index.ts');
