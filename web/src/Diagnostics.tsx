import { useEffect, useState } from 'react';
import { api } from './api.ts';

export function Diagnostics({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const load = (refresh = false) => {
    setData(null);
    api('GET', `/api/diagnostics${refresh ? '?refresh=1' : ''}`).then(setData).catch((e) => setErr(e.message));
  };
  useEffect(() => load(), []);

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
    </div>
  );
}
