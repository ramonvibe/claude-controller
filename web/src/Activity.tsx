import { useEffect, useState } from 'react';
import { api, fmtTokens, ROLE_LABELS } from './api.ts';

type Props = { events: any[]; agents: any[]; tick: number; fmtUsd: (v: number | null) => string };

function describe(ev: any, name: (id: string) => string) {
  const who = ev.agentId ? name(ev.agentId) : 'orquestrador';
  switch (ev.kind) {
    case 'run_started': return `Run iniciado: ${ev.payload.prompt.slice(0, 80)}`;
    case 'run_done': return `Run ${ev.payload.status === 'done' ? 'concluído' : 'falhou'}: ${ev.payload.summary ?? ''}`;
    case 'handoff': return `Handoff ${ev.payload.handoff.task_id} → ${who} (${ROLE_LABELS[ev.payload.role] ?? ev.payload.role}, ~${ev.payload.tokens} tokens)${ev.payload.reason ? ' · ' + ev.payload.reason : ''}`;
    case 'started': return `${who} começou (${ROLE_LABELS[ev.payload.role] ?? ev.payload.role})`;
    case 'tool_use': return `${who} usou ${ev.payload.name}`;
    case 'usage': return `${who}: ${fmtTokens(ev.payload.input + ev.payload.output + ev.payload.cacheRead + ev.payload.cacheCreate)} tokens (${ev.payload.model})`;
    case 'result': return `${who} concluiu`;
    case 'error': return `${who} erro: ${ev.payload.message}`;
    case 'status': return `${who}: ${ev.payload.text}`;
    default: return null;
  }
}

export function Activity({ events, agents, tick, fmtUsd }: Props) {
  const [runs, setRuns] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  useEffect(() => {
    api('GET', '/api/runs').then(setRuns).catch(() => {});
    if (sel) api('GET', `/api/runs/${sel}`).then(setDetail).catch(() => {});
  }, [tick, sel]);

  const feed = events.map((e) => [e, describe(e, name)] as const).filter(([, d]) => d);
  const totals = detail?.usage ?? [];
  const opus = totals.filter((u: any) => /opus/.test(u.model)).reduce((s: number, u: any) => s + u.input + u.output + u.cacheRead + u.cacheCreate, 0);
  const all = totals.reduce((s: number, u: any) => s + u.input + u.output + u.cacheRead + u.cacheCreate, 0);
  const priced = totals.some((u: any) => u.priced);
  const cost = priced ? totals.reduce((s: number, u: any) => s + (u.costUsd ?? 0), 0) : null;

  return (
    <aside className="activity-panel" aria-label="Atividade">
      <h2>Atividade</h2>
      <ol className="feed">
        {feed.slice(-120).map(([e, d]) => (
          <li key={e.id} className={`ev ${e.kind}`}>
            <time>{new Date(e.ts).toLocaleTimeString()}</time> {d}
          </li>
        ))}
        {!feed.length && <li className="muted">Sem atividade ainda.</li>}
      </ol>

      <h2>Execuções</h2>
      <select value={sel ?? ''} onChange={(e) => setSel(e.target.value || null)} aria-label="Escolher execução">
        <option value="">Escolha uma execução…</option>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {new Date(r.started_at).toLocaleTimeString()} · {r.mode} · {r.status} · {String(r.prompt).slice(0, 40)}
          </option>
        ))}
      </select>
      {detail && (
        <div className="run-summary">
          <p>
            <strong>Opus: {fmtTokens(opus)}</strong> de {fmtTokens(all)} tokens · {fmtUsd(cost)}
          </p>
          <table>
            <thead><tr><th>Agente</th><th>Modelo</th><th>Entrada</th><th>Saída</th><th>Cache</th><th>Custo</th></tr></thead>
            <tbody>
              {totals.map((u: any) => (
                <tr key={u.agentId + u.model} className={/opus/.test(u.model) ? 'opus' : ''}>
                  <td>{name(u.agentId)}</td><td>{u.model}</td><td>{fmtTokens(u.input)}</td><td>{fmtTokens(u.output)}</td>
                  <td>{fmtTokens(u.cacheRead + u.cacheCreate)}</td><td>{fmtUsd(u.priced ? u.costUsd : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ol className="tasks">
            {detail.tasks.map((t: any) => (
              <li key={t.id} className={t.status}>{ROLE_LABELS[t.role] ?? t.role} · {name(t.agent_id)} · {t.status}</li>
            ))}
          </ol>
        </div>
      )}
    </aside>
  );
}
