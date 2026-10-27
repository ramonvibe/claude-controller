import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe } from './api.ts';
import { applyEvent, cardStatus, fromSnapshot, type StatusState } from './status.ts';
import { Card, type UsageRow } from './Card.tsx';
import { CompactCard } from './CompactCard.tsx';
import { RunTrace } from './RunTrace.tsx';
import { Diagnostics } from './Diagnostics.tsx';
import { Routing } from './Routing.tsx';
import { Tiers, type Tier } from './Tiers.tsx';
import { Providers } from './Providers.tsx';
import { Connectors } from './Connectors.tsx';
import { DefaultSkills, type SkillInfo } from './Skills.tsx';
import { Preflight } from './Preflight.tsx';
import { Economy } from './Economy.tsx';

type Snapshot = {
  agents: any[];
  settings: { workspace: string | null; testCommands: string[]; parallel: boolean; mode: 'pipeline' | 'agent'; routing: Record<string, string[]>; skills: string[]; review?: Record<string, boolean>; tierHints?: Record<string, string>; repoMap?: string | null; tiers?: Tier[] };
  providers: { id: string; label: string; models: string[]; external: boolean; tier?: string | null; modelTiers?: Record<string, string> }[];
  mcps?: { id: string; label: string; kind: string; providers: string[]; available: boolean; schemaTokens: number | null }[];
  usage: UsageRow[];
  live: any;
  rateLimit: any;
};
type View = 'main' | 'config' | 'economy' | 'providers' | 'diag';

const NEW_AGENT = { name: 'Novo agente', provider: 'claude-cli', model: 'haiku', role: 'coder' };

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<StatusState>({ running: {}, error: {} });
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState('');
  const [view, setView] = useState<View>('main');
  const [tick, setTick] = useState(0);
  const [latestRun, setLatestRun] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<any[] | null>(null);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => {});

  refresh.current = async () => {
    const [s, mcps, sk, runs] = await Promise.all([api<Snapshot>('GET', '/api/state'), api('GET', '/api/mcps'), api<SkillInfo[]>('GET', '/api/skills'), api<any[]>('GET', '/api/runs')]);
    setActiveRun(runs.find((r) => r.status === 'running')?.id ?? null);
    setSnap({ ...s, mcps });
    setSkills(sk);
    setStatus(fromSnapshot(s.live));
    setUsage(s.usage);
  };

  useEffect(
    () =>
      subscribe(
        (ev) => {
          setStatus((s) => applyEvent(s, ev));
          if (ev.kind === 'agents_changed') refresh.current();
          if (ev.kind === 'rate_limit') setSnap((s) => s && { ...s, rateLimit: ev.payload.info });
          if (ev.kind === 'usage') setUsage((u) => [...u, { agentId: ev.agentId, ...ev.payload, priced: ev.payload.costUsd == null ? 0 : 1 }]);
          if (ev.kind === 'run_started') {
            setLatestRun(ev.runId);
            setActiveRun(ev.runId);
            document.title = '● Rodando · Claude Controller';
          }
          if (ev.kind === 'run_done') {
            setActiveRun((r) => (r === ev.runId ? null : r));
            document.title = `${ev.payload.status === 'done' ? '✓ Terminou' : '✗ Terminou com problemas'} · Claude Controller`;
          }
          if (ev.runId && ev.kind !== 'delta') setTick((t) => t + 1);
          if (ev.agentId) {
            const line = ev.kind === 'delta' ? ev.payload.text : ev.kind === 'tool_use' ? `usando ${ev.payload.name}` : ev.kind === 'started' ? 'começou' : null;
            if (line) setActivity((a) => ({ ...a, [ev.agentId]: String(line).slice(0, 160) }));
          }
        },
        () => refresh.current(),
      ),
    [],
  );

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setErr('');
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  const byAgent = useMemo(() => {
    const m: Record<string, UsageRow[]> = {};
    for (const u of usage) (m[u.agentId] ??= []).push(u);
    return m;
  }, [usage]);

  if (!snap) return <main className="loading">Conectando…</main>;
  if (view === 'diag') return <Diagnostics onBack={() => setView('main')} />;
  if (view === 'providers') return <Providers onBack={() => { setView('main'); refresh.current(); }} connectors={<Connectors />} />;

  const settings = snap.settings;
  const saveSettings = (patch: Partial<Snapshot['settings']>) =>
    act(async () => {
      const s = await api('PUT', '/api/settings', { ...settings, ...patch });
      setSnap({ ...snap, settings: s });
    });
  const run = (overrides: Record<string, string> = {}) => act(async () => {
    setPreflight(null);
    await api('POST', '/api/runs', { prompt, overrides });
  });
  const start = () => act(async () => {
    const pf = await api('GET', '/api/preflight');
    if (pf.ok) await run();
    else setPreflight(pf.problems);
  });
  const fiveH = snap.rateLimit?.unifiedWindows?.five_hour;
  const sevenD = snap.rateLimit?.unifiedWindows?.seven_day;
  const editAgent = snap.agents.find((a) => a.id === editing);
  const providerOf = (id: string) => snap.providers.find((p) => p.id === id);
  const freeConnected = snap.providers.some((p) => p.external);
  const nav = (
    <nav className="nav">
      {(['main', 'config', 'economy', 'providers', 'diag'] as View[]).map((v) => (
        <button key={v} className={`link ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>
          {{ main: 'Início', config: 'Configurar', economy: 'Economia', providers: 'Provedores', diag: 'Diagnóstico' }[v]}
        </button>
      ))}
    </nav>
  );

  return (
    <div className="app">
      <header>
        <h1>Claude Controller</h1>
        {nav}
        <div className="meters" aria-label="Cota do Claude">
          {fiveH && <span className="meter strong" title={`reinicia ${new Date(fiveH.resetsAt * 1000).toLocaleString()}`}>cota 5h: {Math.round(fiveH.utilization * 100)}%</span>}
          {sevenD && <span className="meter">7d: {Math.round(sevenD.utilization * 100)}%</span>}
        </div>
      </header>
      {err && <p className="err" role="alert">{err}</p>}

      {view === 'economy' ? (
        <Economy />
      ) : view === 'config' ? (
        <>
          <section className="panel settings" aria-label="Workspace">
            <label>
              Workspace (pasta do projeto)
              <input defaultValue={settings.workspace ?? ''} placeholder="/caminho/do/projeto"
                onBlur={(e) => e.target.value !== (settings.workspace ?? '') && saveSettings({ workspace: e.target.value || null })} />
            </label>
            <label>
              Comandos de teste permitidos
              <input defaultValue={settings.testCommands.join(', ')} onBlur={(e) => saveSettings({ testCommands: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            </label>
            <label>
              Modo
              <select value={settings.mode} onChange={(e) => saveSettings({ mode: e.target.value as any })}>
                <option value="pipeline">Pipeline: o Opus só planeja (gasta menos)</option>
                <option value="agent">Agente: o Opus delega sozinho (gasta mais Opus)</option>
              </select>
            </label>
            <label title="Um modelo barato/grátis resume o projeto antes; o Opus planeja lendo o resumo em vez do código. Reaproveitado enquanto nada muda.">
              Mapa do repositório feito por
              <select value={settings.repoMap ?? ''} onChange={(e) => saveSettings({ repoMap: e.target.value || null })}>
                <option value="">ninguém (o Opus lê o código)</option>
                {snap.agents.filter((a) => a.enabled).map((a) => <option key={a.id} value={a.id}>{a.name} · {a.model}</option>)}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.parallel} onChange={(e) => saveSettings({ parallel: e.target.checked })} />
              Paralelo (experimental)
            </label>
          </section>
          <Routing routing={settings.routing} review={settings.review ?? {}} hints={settings.tierHints ?? {}} agents={snap.agents.filter((a) => a.enabled)}
            onChange={(routing) => saveSettings({ routing })} onReview={(review) => saveSettings({ review })} onHints={(tierHints) => saveSettings({ tierHints })} />
          <Tiers tiers={settings.tiers ?? []} agents={snap.agents.filter((a) => a.enabled)} onChange={(tiers) => saveSettings({ tiers })} />
          <DefaultSkills all={skills} value={settings.skills} onChange={(ids) => saveSettings({ skills: ids })} />
        </>
      ) : (
        <>
          {(!settings.workspace || !freeConnected) && (
            <section className="panel onboarding" aria-label="Primeiros passos">
              <b>Primeiros passos</b>
              <ol>
                <li className={settings.workspace ? 'ok' : ''}>{settings.workspace ? `Workspace: ${settings.workspace}` : <>Defina a pasta do projeto em <button className="link" onClick={() => setView('config')}>Configurar</button>.</>}</li>
                <li>Conecte IAs grátis (DeepSeek, Gemini, OpenRouter…) em <button className="link" onClick={() => setView('providers')}>Provedores</button>, para o Claude só planejar.</li>
                <li>Em <button className="link" onClick={() => setView('config')}>Configurar</button>, escolha quem faz cada tipo de tarefa.</li>
              </ol>
            </section>
          )}
          <section className="prompt" aria-label="Pedido">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="O que você quer construir ou corrigir?" rows={3} />
            {activeRun ? (
              <button onClick={() => act(() => api('POST', `/api/runs/${activeRun}/cancel`))}>Rodando… Cancelar</button>
            ) : (
              <button className="primary" disabled={!prompt.trim()} onClick={start}>Rodar</button>
            )}
          </section>

          <div className="layout">
            <section className="grid" aria-label="Agentes">
              {snap.agents.map((a) => (
                <CompactCard key={a.id} agent={a} provider={providerOf(a.provider)} status={cardStatus(status, a.id)} activity={activity[a.id]} usage={byAgent[a.id] ?? []}
                  onEdit={() => setEditing(a.id)}
                  onCancel={() => act(async () => { for (const t of status.running[a.id] ?? []) await api('POST', `/api/tasks/${t}/cancel`); })} />
              ))}
              <button className="add" onClick={() => act(() => api('POST', '/api/agents', NEW_AGENT))} aria-label="Adicionar agente">+<span>Adicionar</span></button>
            </section>
            <RunTrace tick={tick} latestRun={latestRun} />
          </div>
        </>
      )}

      {editAgent && (
        <div className="modal" role="dialog" aria-modal="true" aria-label={`Editar ${editAgent.name}`} onClick={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal-box">
            <Card agent={editAgent} providers={snap.providers} mcps={snap.mcps ?? []} status={cardStatus(status, editAgent.id)} skills={skills} defaultSkills={settings.skills}
              activity={activity[editAgent.id]} usage={byAgent[editAgent.id] ?? []} canRun={Boolean(prompt.trim())}
              onSave={(next) => act(() => api('PUT', `/api/agents/${editAgent.id}`, next))}
              onDelete={() => act(async () => { await api('DELETE', `/api/agents/${editAgent.id}`); setEditing(null); })}
              onRun={() => act(() => api('POST', '/api/tasks', { agentId: editAgent.id, prompt }))}
              onCancel={() => act(async () => { for (const t of status.running[editAgent.id] ?? []) await api('POST', `/api/tasks/${t}/cancel`); })} />
            <div className="card-actions"><span /><button onClick={() => setEditing(null)}>Fechar</button></div>
          </div>
        </div>
      )}

      {preflight && <Preflight problems={preflight} onRun={run} onCancel={() => setPreflight(null)} onConnect={() => { setPreflight(null); setView('providers'); }} />}
    </div>
  );
}
