import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp, fakeScript, startApp, collect } from './helpers.ts';
import { listSkills, skillsPrompt } from '../server/skills.ts';

function skill(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "desc ${name}"\n---\n${body}\n`);
}

test('listSkills: user, newest plugin version only, workspace; prompt text built from bodies', () => {
  const home = tmp();
  const ws = tmp();
  skill(join(home, '.claude/skills/minha'), 'minha', 'CORPO-MINHA');
  skill(join(home, '.claude/plugins/cache/mk/pl/1.0.0/skills/velha'), 'velha', 'OLD');
  skill(join(home, '.claude/plugins/cache/mk/pl/2.0.0/skills/nova'), 'nova', 'NEW');
  skill(join(ws, '.claude/skills/proj'), 'proj', 'P');
  const all = listSkills(ws, home);
  assert.deepEqual(all.map((s) => s.id), ['pl:nova', 'projeto:proj', 'usuário:minha']);
  assert.equal(all[2].description, 'desc minha');
  const p = skillsPrompt(['usuário:minha', 'nao:existe'], all);
  assert.match(p, /# Skill: minha\nCORPO-MINHA/);
  assert.ok(!p.includes('existe'));
});

test('default skills reach every agent; a card can override them', async () => {
  const log = fakeScript([{ text: 'a' }, { text: 'b' }]);
  const app = await startApp();
  try {
    skill(join(app.ws, '.claude/skills/estilo'), 'estilo', 'SEMPRE-CONCISO');
    await app.api('PUT', '/api/settings', { ...app.store.settings(), skills: ['projeto:estilo'] });
    const skills = await app.api('GET', '/api/skills');
    assert.ok(skills.some((s: any) => s.id === 'projeto:estilo' && s.tokens > 0 && !('body' in s)));
    const coder = app.store.agents().find((a) => a.role === 'coder')!;
    for (const override of [null, []]) {
      await app.api('PUT', `/api/agents/${coder.id}`, { ...coder, skills: override });
      const c = collect(app.port, (evs) => evs.some((e) => e.kind === 'result' || e.kind === 'error'));
      await c.ready;
      await app.api('POST', '/api/tasks', { agentId: coder.id, prompt: 'x' });
      await c.done;
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const sp = (c: any) => c.args[c.args.indexOf('--system-prompt') + 1];
    assert.match(sp(calls[0]), /SEMPRE-CONCISO/);
    assert.ok(!sp(calls[1]).includes('SEMPRE-CONCISO'));
  } finally {
    await app.app.close();
  }
});
