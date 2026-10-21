import { readdir } from 'node:fs/promises';
import type { Adapter } from '../types.ts';

/** Every `*.ts` file in this directory (except this one) default-exports an Adapter: adding a provider is adding a file. */
export async function loadAdapters(): Promise<Map<string, Adapter>> {
  const dir = new URL('.', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts') && f !== 'index.ts' && !f.endsWith('.test.ts')).sort();
  const map = new Map<string, Adapter>();
  for (const f of files) {
    const a: Adapter = (await import(new URL(f, dir).href)).default;
    map.set(a.id, a);
  }
  return map;
}
