import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribe, fmtTokens, fmtUsd } from './api.ts';
import { applyEvent, cardStatus, fromSnapshot, type StatusState } from './status.ts';
import { Card, type UsageRow } from './Card.tsx';
import { Activity } from './Activity.tsx';
import { Diagnostics } from './Diagnostics.tsx';

type Snapshot = {
  agents: any[];
  settings: { workspace: string | null; testCommands: string[]; parallel: boolean; mode: 'pipeline' | 'agent' };
  providers: { id: string; label: string; models: string[]; external: boolean }[];
  mcps?: { id: string; label: string; kind: string; providers: string[]; schemaTokens: number | null }[];
  usage: UsageRow[];
  live: any;
  rateLimit: any;
};

const NEW_AGENT = { name: 'Novo agente', provider: 'claude-cli', model: 'haiku', role: 'coder' };

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<StatusState>({ running: {}, error: {} });
  const [events, setEvents] = useState<any[]>([]);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState('');
  const [view, setView] = useState<'main' | 'diag'>('main');
  const [runsTick, setRunsTick] = useState(0);
  const refresh = useRef<() => void>(() => {});

  refresh.current = async () => {
    const s = await api<Snapshot>('GET', '/api/state');
    setSnap(s);
    setStatus(fromSnapshot(s.live));
    setUsage(s.usage);
  };

  useEffect(
    () =>
      subscribe(
        (ev) => {
          setStatus((s) => applyEvent(s, ev));
          if (ev.kind !== 'delta') setEvents((e) => [...e.slice(-400), ev]);
          if (ev.kind === 'agents_changed') refresh.current();
          if (ev.kind === 'rate_limit') setSnap((s) => s && { ...s, rateLimit: ev.payload.info });
          if (ev.kind === 'usage')
            setUsage((u) => [...u, { agentId: ev.agentId, model: ev.payload.model, ...ev.payload, priced: ev.payload.costUsd == null ? 0 : 1 }]);
          if (['run_started', 'run_done', 'result', 'error'].includes(ev.kind)) setRunsTick((t) => t + 1);
          if (ev.agentId) {
            const line =
              ev.kind === 'started' ? `iniciou (${ev.payload.role}, ~${ev.payload.inputTokens} tokens de entrada)`
              : ev.kind === 'delta' ? ev.payload.text
              : ev.kind === 'tool_use' ? `ferramenta: ${ev.payload.name}`
              : ev.kind === 'status' ? ev.payload.text
              : ev.kind === 'error' ? `erro: ${ev.payload.message}`
              : ev.kind === 'result' ? 'concluiu'
              : null;
            if (line) setActivity((a) => ({ ...a, [ev.agentId]: String(line).slice(0, 240) }));
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

  const opusTokens = usage.filter((u) => /opus/.test(u.model)).reduce((s, u) => s + u.input + u.output + u.cacheRead + u.cacheCreate, 0);
  const windows = snap.rateLimit?.unifiedWindows ?? {};
  const settings = snap.settings;
  const saveSettings = (patch: Partial<Snapshot['settings']>) =>
    act(async () => {
      const s = await api('PUT', '/api/settings', { ...settings, ...patch });
      setSnap({ ...snap, settings: s });
    });
  const running = snap.agents.filter((a) => cardStatus(status, a.id) === 'running').length;

  return (
    <div className="app">
      <header>
        <h1>Claude Controller</h1>
        <div className="meters" aria-label="Consumo">
          <span className="meter strong" title="Tokens de Opus (todas as execuções): a cota escassa do plano">
            Opus: {fmtTokens(opusTokens)} tokens
          </span>
          {Object.entries(windows).map(([k, w]: [string, any]) => (
            <span key={k} className="meter" title={`reinicia ${new Date(w.resetsAt * 1000).toLocaleString()}`}>
              cota {k === 'five_hour' ? '5h' : k === 'seven_day' ? '7d' : k}: {Math.round(w.utilization * 100)}%
            </span>
          ))}
          <span className="meter">{running} ativo(s)</span>
        </div>
        <button className="link" onClick={() => setView('diag')}>Diagnóstico</button>
      </header>

      <section className="settings" aria-label="Workspace">
        <label>
          Workspace
          <input
            defaultValue={settings.workspace ?? ''}
            placeholder="/caminho/do/repositório"
            onBlur={(e) => e.target.value !== (settings.workspace ?? '') && saveSettings({ workspace: e.target.value || null })}
          />
        </label>
        <label>
          Comandos de teste
          <input
            defaultValue={settings.testCommands.join(', ')}
            onBlur={(e) => saveSettings({ testCommands: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
        </label>
        <label>
          Modo
          <select value={settings.mode} onChange={(e) => saveSettings({ mode: e.target.value as any })}>
            <option value="pipeline">Pipeline (backend conduz)</option>
            <option value="agent">Agente (Opus delega via MCP orq)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.parallel} onChange={(e) => saveSettings({ parallel: e.target.checked })} />
          Paralelo (experimental)
        </label>
      </section>

      <section className="prompt" aria-label="Pedido">
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Descreva o que quer construir ou corrigir…" rows={3} />
        <button className="primary" disabled={!prompt.trim()} onClick={() => act(() => api('POST', '/api/runs', { prompt }))}>
          Rodar orquestrado
        </button>
      </section>
      {err && <p className="err" role="alert">{err}</p>}

      <div className="layout">
        <section className="grid" aria-label="Agentes">
          {snap.agents.map((a) => (
            <Card
              key={a.id}
              agent={a}
              providers={snap.providers}
              mcps={snap.mcps ?? []}
              status={cardStatus(status, a.id)}
              activity={activity[a.id]}
              usage={byAgent[a.id] ?? []}
              onSave={(next) => act(() => api('PUT', `/api/agents/${a.id}`, next))}
              onDelete={() => act(() => api('DELETE', `/api/agents/${a.id}`))}
              onRun={() => act(() => api('POST', '/api/tasks', { agentId: a.id, prompt }))}
              onCancel={() => act(async () => {
                for (const t of status.running[a.id] ?? []) await api('POST', `/api/tasks/${t}/cancel`);
              })}
              canRun={Boolean(prompt.trim())}
            />
          ))}
          <button className="add" onClick={() => act(() => api('POST', '/api/agents', NEW_AGENT))} aria-label="Adicionar agente">
            +
            <span>Adicionar</span>
          </button>
        </section>
        <Activity events={events} agents={snap.agents} tick={runsTick} fmtUsd={fmtUsd} />
      </div>
    </div>
  );
}
