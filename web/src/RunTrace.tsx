import { useEffect, useRef, useState } from 'react';
import { api, fmtTokens, fmtUsd, ROLE_LABELS } from './api.ts';
import { CATEGORY_LABELS } from './Routing.tsx';

const total = (t: any) => t.novos + t.reaproveitados + t.saida;
const secs = (ms: number | null) => (ms == null ? '…' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
const STATUS: Record<string, string> = { done: '✓', error: '✗', running: '●', cancelled: '■' };

function Tokens({ t }: { t: any }) {
  return (
    <span className="tok" title="novos (pagos cheio) · reaproveitados do cache (baratos) · saída (texto escrito)">
      {fmtTokens(t.novos)} novos · {fmtTokens(t.reaproveitados)} cache · {fmtTokens(t.saida)} saída
    </span>
  );
}

function TaskRow({ t }: { t: any }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  return (
    <li className={`trace-task ${t.status}`}>
      <button className="trace-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="st" aria-label={t.status}>{STATUS[t.status] ?? '?'}</span>
        <span className="who">
          <strong>{ROLE_LABELS[t.role] ?? t.role}</strong>
          {t.category && <small> · {CATEGORY_LABELS[t.category] ?? t.category}</small>}
          <br />
          <small className="muted">{t.agent.name} · {t.models.join(', ') || t.agent.model}{t.external ? ' · fora do Claude' : ''}</small>
        </span>
        <span className="nums">
          <Tokens t={t.tokens} />
          <small className="muted">{secs(t.durationMs)} · {t.tools.length} ferramenta(s){t.tokens.costUsd != null ? ` · ${fmtUsd(t.tokens.costUsd)}` : ''}</small>
        </span>
      </button>
      {open && (
        <div className="trace-body">
          {t.summary && <p><b>Resultado:</b> {t.summary}</p>}
          {t.filesChanged.length > 0 && <p><b>Arquivos:</b> {t.filesChanged.join(', ')}</p>}
          <details>
            <summary>O que recebeu (handoff)</summary>
            <pre>{t.input}</pre>
          </details>
          {t.tools.length > 0 && (
            <details>
              <summary>Ferramentas usadas ({t.tools.length})</summary>
              <ol className="tools">{t.tools.map((x: any, i: number) => <li key={i}><code>{x.name}</code> {x.target}</li>)}</ol>
            </details>
          )}
          {t.hasDiff && (
            <details onToggle={(e) => (e.target as HTMLDetailsElement).open && diff === null && api('GET', `/api/tasks/${t.id}/diff`).then((d) => setDiff(d.diff + (d.note ? `\n(${d.note})` : '')))}>
              <summary>O que mudou (diff)</summary>
              <pre className="diff">{diff ?? 'carregando…'}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

/** Timeline of a run, refreshed by WebSocket ticks. */
export function RunTrace({ tick, latestRun }: { tick: number; latestRun: string | null }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [trace, setTrace] = useState<any>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (latestRun) setSel(latestRun);
  }, [latestRun]);
  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api('GET', '/api/runs').then((r) => {
        setRuns(r);
        const id = sel ?? r[0]?.id;
        if (id) api('GET', `/api/runs/${id}/trace`).then(setTrace).catch(() => {});
      }).catch(() => {});
    }, 250);
  }, [tick, sel]);

  if (!runs.length) return <aside className="trace"><h2>Linha do tempo</h2><p className="muted">Nenhum pedido rodado ainda.</p></aside>;
  const tt = trace?.totals;
  const q = tt?.quota;
  const saved = tt && tt.outsideTokens + tt.claudeTokens > 0 ? Math.round((100 * tt.outsideTokens) / (tt.outsideTokens + tt.claudeTokens)) : 0;
  return (
    <aside className="trace" aria-label="Linha do tempo">
      <h2>Linha do tempo</h2>
      <select value={sel ?? runs[0].id} onChange={(e) => setSel(e.target.value)} aria-label="Escolher pedido">
        {runs.map((r) => (
          <option key={r.id} value={r.id}>{new Date(r.started_at).toLocaleString()} · {STATUS[r.status] ?? r.status} {String(r.prompt).slice(0, 50)}</option>
        ))}
      </select>
      {trace && (
        <>
          <div className="kpis">
            <div><dt>Cota 5h</dt><dd>{q ? `${Math.round(q.before * 100)}% → ${Math.round(q.after * 100)}%` : '—'}</dd></div>
            <div><dt>Opus</dt><dd>{fmtTokens(tt.opusTokens)}</dd></div>
            <div><dt>Feito fora do Claude</dt><dd>{saved}%</dd></div>
          </div>
          <p className="muted small">
            Claude processou {fmtTokens(tt.claudeTokens)} tokens; {fmtTokens(tt.outsideTokens)} ficaram com outras IAs. Modo: {trace.run.mode}. Custo de lista: {fmtUsd(tt.costUsd)}.
          </p>
          {trace.run.summary && <p className="run-sum">{trace.run.summary}</p>}
          <ol className="trace-list">{trace.tasks.map((t: any) => <TaskRow key={t.id} t={t} />)}</ol>
        </>
      )}
    </aside>
  );
}
