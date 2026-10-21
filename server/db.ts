import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Agent, BusEvent, Settings, Usage } from './types.ts';

const DEFAULT_SETTINGS: Settings = { workspace: null, testCommands: ['npm test'], parallel: false, mode: 'pipeline', routing: {}, skills: [] };

/** Cards saved by older versions lack newer fields. */
const withDefaults = (a: Agent): Agent => ({ ...a, mcps: a.mcps ?? [], skills: a.skills === undefined ? null : a.skills, effort: a.effort ?? null });

export class Store {
  db: DatabaseSync;
  bus = new EventEmitter();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, 'controller.db'));
    this.db.exec(`
      create table if not exists agents (id text primary key, pos integer, data text not null);
      create table if not exists kv (key text primary key, value text not null);
      create table if not exists runs (id text primary key, prompt text, mode text, status text, started_at integer, ended_at integer, summary text);
      create table if not exists tasks (id text primary key, run_id text, parent_id text, role text, agent_id text,
        input text, status text, result text, started_at integer, ended_at integer);
      create table if not exists events (id integer primary key autoincrement, run_id text, task_id text, agent_id text,
        ts integer, kind text, payload text);
      create table if not exists usage (task_id text, run_id text, agent_id text, model text, input integer, output integer,
        cache_read integer, cache_create integer, cost_usd real, source text);
      create table if not exists notes (run_id text, ts integer, author text, text text);
      create table if not exists providers (id text primary key, data text not null);
    `);
    // Columns added after the first release (existing databases).
    for (const col of ['snap_before text', 'snap_after text', 'category text'])
      try {
        this.db.exec(`alter table tasks add column ${col}`);
      } catch {}
    // A previous process died mid-task: those tasks can never finish.
    this.db.exec(`update tasks set status='error', result='{"error":"processo reiniciado"}' where status='running'`);
    this.db.exec(`update runs set status='error' where status='running'`);
  }

  emit(ev: Omit<BusEvent, 'ts' | 'id'>) {
    const full: BusEvent = { ...ev, ts: Date.now() };
    const r = this.db
      .prepare('insert into events (run_id, task_id, agent_id, ts, kind, payload) values (?,?,?,?,?,?)')
      .run(full.runId, full.taskId, full.agentId, full.ts, full.kind, JSON.stringify(full.payload ?? null));
    full.id = Number(r.lastInsertRowid);
    this.bus.emit('event', full);
    return full;
  }

  settings(): Settings {
    const row = this.db.prepare(`select value from kv where key='settings'`).get() as { value: string } | undefined;
    return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
  }

  saveSettings(s: Settings) {
    this.db.prepare(`insert into kv (key, value) values ('settings', ?) on conflict(key) do update set value=excluded.value`).run(JSON.stringify(s));
  }

  mcpTokens(): Record<string, number> {
    const row = this.db.prepare(`select value from kv where key='mcpTokens'`).get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) : {};
  }

  saveMcpTokens(v: Record<string, number>) {
    this.db.prepare(`insert into kv (key, value) values ('mcpTokens', ?) on conflict(key) do update set value=excluded.value`).run(JSON.stringify(v));
  }

  providers(): any[] {
    return (this.db.prepare('select data from providers order by rowid').all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  saveProvider(p: { id: string }) {
    this.db.prepare('insert into providers (id, data) values (?, ?) on conflict(id) do update set data=excluded.data').run(p.id, JSON.stringify(p));
  }

  deleteProvider(id: string) {
    this.db.prepare('delete from providers where id=?').run(id);
  }

  agents(): Agent[] {
    return (this.db.prepare('select data from agents order by pos, rowid').all() as { data: string }[]).map((r) => withDefaults(JSON.parse(r.data)));
  }

  agent(id: string): Agent | undefined {
    const r = this.db.prepare('select data from agents where id=?').get(id) as { data: string } | undefined;
    return r && withDefaults(JSON.parse(r.data));
  }

  saveAgent(a: Agent) {
    this.db
      .prepare(`insert into agents (id, pos, data) values (?, (select coalesce(max(pos),0)+1 from agents), ?)
        on conflict(id) do update set data=excluded.data`)
      .run(a.id, JSON.stringify(a));
  }

  deleteAgent(id: string) {
    this.db.prepare('delete from agents where id=?').run(id);
  }

  createRun(id: string, prompt: string, mode: string) {
    this.db.prepare(`insert into runs (id, prompt, mode, status, started_at) values (?,?,?,'running',?)`).run(id, prompt, mode, Date.now());
  }

  endRun(id: string, status: string, summary: unknown) {
    this.db.prepare('update runs set status=?, ended_at=?, summary=? where id=?').run(status, Date.now(), JSON.stringify(summary), id);
  }

  createTask(t: { id: string; runId: string; parentId: string | null; role: string; agentId: string; input: string; category?: string | null }) {
    this.db
      .prepare(`insert into tasks (id, run_id, parent_id, role, agent_id, input, status, started_at, category) values (?,?,?,?,?,?,'running',?,?)`)
      .run(t.id, t.runId, t.parentId, t.role, t.agentId, t.input, Date.now(), t.category ?? null);
  }

  setSnapshot(id: string, which: 'before' | 'after', tree: string | null) {
    this.db.prepare(`update tasks set snap_${which}=? where id=?`).run(tree, id);
  }

  endTask(id: string, status: 'done' | 'error', result: unknown) {
    this.db.prepare('update tasks set status=?, result=?, ended_at=? where id=?').run(status, JSON.stringify(result), Date.now(), id);
  }

  addUsage(taskId: string, runId: string, agentId: string, u: Usage) {
    this.db
      .prepare('insert into usage values (?,?,?,?,?,?,?,?,?,?)')
      .run(taskId, runId, agentId, u.model, u.input, u.output, u.cacheRead, u.cacheCreate, u.costUsd, u.source);
  }

  /** Tasks currently running, plus each agent's latest task status: enough to rebuild card colors on reload. */
  liveState() {
    const running = this.db.prepare(`select id, run_id runId, agent_id agentId, role from tasks where status='running'`).all();
    const last = this.db
      .prepare(`select agent_id agentId, status from tasks t where started_at = (select max(started_at) from tasks where agent_id=t.agent_id)`)
      .all();
    return { running, last };
  }

  /** Token totals per agent and model, for a run or overall. */
  usageTotals(runId?: string) {
    const where = runId ? 'where run_id=?' : '';
    return this.db
      .prepare(`select agent_id agentId, model, sum(input) input, sum(output) output, sum(cache_read) cacheRead,
        sum(cache_create) cacheCreate, sum(cost_usd) costUsd, count(cost_usd) priced, count(*) n, group_concat(distinct source) sources
        from usage ${where} group by agent_id, model`)
      .all(...(runId ? [runId] : []));
  }

  runs(limit = 30) {
    return this.db.prepare('select * from runs order by started_at desc limit ?').all(limit);
  }

  run(id: string) {
    const run = this.db.prepare('select * from runs where id=?').get(id);
    if (!run) return null;
    const tasks = this.db.prepare('select * from tasks where run_id=? order by started_at').all(id);
    const events = this.db.prepare(`select * from events where run_id=? and kind != 'delta' order by id`).all(id);
    return { run, tasks, events, usage: this.usageTotals(id) };
  }

  task(id: string) {
    return this.db.prepare('select * from tasks where id=?').get(id) as any;
  }

  notes(runId: string) {
    return this.db.prepare('select ts, author, text from notes where run_id=? order by ts').all(runId);
  }

  addNote(runId: string, author: string, text: string) {
    this.db.prepare('insert into notes values (?,?,?,?)').run(runId, Date.now(), author, text);
  }
}
