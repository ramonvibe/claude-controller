import { useEffect, useState } from 'react';
import { api, fmtTokens } from './api.ts';

const PERIODS: [number, string][] = [[1, '24h'], [7, '7 dias'], [30, '30 dias'], [0, 'tudo']];
const usd = (v: number) => `US$ ${v.toFixed(2)}`;

/** Tokens per AI over a period, the share kept out of Claude, and what each provider still has available. */
export function Economy() {
  const [days, setDays] = useState(7);
  const [eco, setEco] = useState<any>(null);
  const [avail, setAvail] = useState<any[] | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    api('GET', `/api/economy${days ? `?days=${days}` : ''}`).then(setEco).catch((e) => setErr(e.message));
  }, [days]);
  const loadAvail = () => {
    setAvail(null);
    api('GET', '/api/economy/available').then(setAvail).catch((e) => setErr(e.message));
  };
  useEffect(loadAvail, []);

  const t = eco?.totals;
  const all = t ? t.claudeTokens + t.outsideTokens : 0;
  return (
    <div className="economy">
      {err && <p className="err" role="alert">{err}</p>}
      <section className="panel">
        <div className="eco-head">
          <h2>Consumo por IA</h2>
          <div className="seg" role="group" aria-label="Período">
            {PERIODS.map(([d, l]) => <button key={d} className={days === d ? 'on' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{l}</button>)}
          </div>
        </div>
        {t && (
          <>
            <div className="kpis">
              <div><dt>Feito fora do Claude</dt><dd>{all ? Math.round((100 * t.outsideTokens) / all) : 0}%</dd></div>
              <div><dt>Claude</dt><dd>{fmtTokens(t.claudeTokens)}</dd></div>
              <div><dt>Opus</dt><dd>{fmtTokens(t.opusTokens)}</dd></div>
              <div><dt>Outras IAs</dt><dd>{fmtTokens(t.outsideTokens)}</dd></div>
            </div>
            <p className="muted small">{t.runs} pedido(s). Custo de lista do Claude: {usd(t.claudeCostUsd)} (estimativa; no plano Pro o que conta é a cota).</p>
            {eco.models.length === 0 ? <p className="muted">Nada rodado neste período.</p> : (
              <div className="table-wrap">
                <table className="eco-table">
                  <thead><tr><th>IA (modelo)</th><th>Onde</th><th>Cards</th><th>Chamadas</th><th title="Tokens de entrada pagos cheio">Novos</th><th title="Reaproveitados do cache (baratos)">Cache</th><th>Saída</th><th>Custo de lista</th></tr></thead>
                  <tbody>
                    {eco.models.map((m: any) => (
                      <tr key={m.model} className={m.outside ? '' : /opus/.test(m.model) ? 'opus' : 'claude'}>
                        <td><code>{m.model}</code></td>
                        <td>{m.outside ? 'fora do Claude' : 'Claude'}</td>
                        <td>{m.agents.join(', ') || '—'}</td>
                        <td>{m.calls}</td>
                        <td>{fmtTokens(m.novos)}</td>
                        <td>{fmtTokens(m.cache)}</td>
                        <td>{fmtTokens(m.saida)}</td>
                        <td>{m.unpriced === m.calls ? 'sem preço' : m.costUsd ? usd(m.costUsd) : 'grátis'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <div className="eco-head">
          <h2>Disponível</h2>
          <button onClick={loadAvail}>Atualizar</button>
        </div>
        {!avail && <p className="muted">Consultando provedores…</p>}
        <ul className="avail">
          {avail?.map((p) => (
            <li key={p.id}>
              <b>{p.label}</b>{' '}
              {p.kind === 'quota' && (p.fiveHour || p.sevenDay ? (
                <span>cota 5h: {p.fiveHour ? `${p.fiveHour.usedPct}% usada (sobram ${100 - p.fiveHour.usedPct}%)` : '—'} · 7d: {p.sevenDay ? `${p.sevenDay.usedPct}% usada` : '—'}</span>
              ) : <span className="muted">aparece depois da primeira chamada ao Claude</span>)}
              {p.kind === 'api' && (
                <span>
                  {p.balance?.text ?? (p.balance?.error ? `saldo: erro ${p.balance.error}` : 'este provedor não informa saldo')}
                  {p.limits && <small className="muted"> · limites na última resposta ({new Date(p.limits.at).toLocaleTimeString()}): {Object.entries(p.limits.headers).map(([k, v]) => `${k.replace('x-ratelimit-', '')}=${v}`).join(', ')}</small>}
                </span>
              )}
              <br /><small className="muted">{p.note ?? ''}</small>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
