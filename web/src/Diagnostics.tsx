import { useEffect, useState } from 'react';
import { api } from './api.ts';

export function Diagnostics({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [mcps, setMcps] = useState<any[]>([]);
  const [measuring, setMeasuring] = useState<string | null>(null);
  const loadMcps = () => api('GET', '/api/mcps').then(setMcps).catch((e) => setErr(e.message));
  const measure = async (id: string) => {
    setMeasuring(id);
    setErr('');
    try {
      await api('POST', `/api/mcps/${id}/measure`);
      await loadMcps();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setMeasuring(null);
    }
  };
  const load = (refresh = false) => {
    setData(null);
    api('GET', `/api/diagnostics${refresh ? '?refresh=1' : ''}`).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(() => {
    load();
    loadMcps();
  }, []);

  return (
    <div className="app diag">
      <header>
        <h1>Diagnóstico</h1>
        <button className="link" onClick={onBack}>Voltar</button>
        <button onClick={() => load(true)}>Testar de novo</button>
      </header>
      {err && <p className="err" role="alert">{err}</p>}
      {!data && !err && <p>Verificando provedores…</p>}
      {data?.map((p) => (
        <section key={p.id} className={`card ${p.ok ? 'idle' : 'error'}`}>
          <h2>{p.label}</h2>
          <dl>
            <dt>Versão</dt><dd>{p.version ?? '—'}</dd>
            <dt>Autenticação</dt><dd className={p.auth === 'ok' ? 'ok' : 'bad'}>{p.auth}</dd>
            <dt>Detalhe</dt><dd>{p.detail || '—'}</dd>
          </dl>
          {Object.keys(p.capabilities).length > 0 && (
            <ul className="caps">
              {Object.entries(p.capabilities).map(([k, v]) => (
                <li key={k} className={v ? 'ok' : 'bad'}>{v ? '✓' : '✗'} {k}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <section className="card idle">
        <h2>MCPs e allowlists</h2>
        <p className="muted">Cada preset soma tokens a toda chamada do agente. A medição faz duas chamadas enxutas no Haiku, com e sem o preset, e usa o workspace atual.</p>
        <table className="mcp-table">
          <thead><tr><th>Preset</th><th>Tipo</th><th>Disponível</th><th>Tokens por chamada</th><th></th></tr></thead>
          <tbody>
            {mcps.map((m) => (
              <tr key={m.id}>
                <td>{m.label}</td>
                <td>{m.kind === 'mcp' ? 'servidor MCP' : 'allowlist'}</td>
                <td className={m.available ? 'ok' : 'bad'}>{m.available ? 'sim' : 'falta variável de ambiente'}</td>
                <td>{m.schemaTokens ?? 'não medido'}</td>
                <td><button disabled={!m.available || measuring !== null} onClick={() => measure(m.id)}>{measuring === m.id ? 'Medindo…' : 'Medir'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
