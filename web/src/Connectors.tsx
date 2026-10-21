import { useEffect, useState } from 'react';
import { api, subscribe } from './api.ts';
import { tierTag } from './Providers.tsx';

export function Connectors() {
  const [list, setList] = useState<any[]>([]);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = (refresh = false) => api('GET', `/api/connect${refresh ? '?refresh=1' : ''}`).then(setList).catch(() => {});

  useEffect(() => {
    load();
    return subscribe(
      (ev) => {
        if (ev.kind !== 'connect') return;
        const { id, status, url, detail } = ev.payload;
        if (url) window.open(url, '_blank', 'noopener');
        setMsg((m) => ({ ...m, [id]: status === 'ok' ? 'Conectado.' : status === 'waiting' ? 'Aguardando você concluir o login na aba aberta…' : detail || status }));
        if (status !== 'waiting') load();
      },
      () => {},
    );
  }, []);

  const act = async (id: string, path: string, note?: string) => {
    setBusy(id);
    try {
      const r = await api('POST', path);
      if (r?.url) window.open(r.url, '_blank', 'noopener');
      setMsg((m) => ({ ...m, [id]: r?.message ?? note ?? 'ok' }));
      load();
    } catch (e: any) {
      setMsg((m) => ({ ...m, [id]: e.message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="connectors">
      {list.map((c) => (
        <section key={c.id} className={`card ${c.auth === 'ok' ? 'running' : c.pending ? 'idle' : 'error'}`}>
          <div className="card-head">
            <span className="dot" aria-hidden />
            <strong>{c.label}</strong>
            <span className={`tier ${c.tier === 'free' ? 'free' : 'paid'}`}>{tierTag(c.tier)}</span>
          </div>
          <small className="muted">{c.loginNote}</small>
          <p className={c.auth === 'ok' ? 'ok' : 'bad'}>{c.auth === 'ok' ? 'Conectado' : !c.installed ? 'Não instalado' : c.auth}</p>
          {msg[c.id] && <p className="muted" role="status">{msg[c.id]}</p>}
          <div className="card-actions">
            {c.id === 'gemini-cli' && !c.installed && (
              <button disabled={busy !== null} onClick={() => act(c.id, '/api/connect/gemini-cli/install', 'Instalado.')}>{busy === c.id ? 'Instalando…' : 'Instalar'}</button>
            )}
            {c.canConnect && c.auth !== 'ok' && !c.pending && (
              <button className="primary" disabled={busy !== null} onClick={() => act(c.id, `/api/connect/${c.id}`)}>Conectar</button>
            )}
            {c.pending && <button onClick={() => act(c.id, `/api/connect/${c.id}/stop`, 'Cancelado.')}>Cancelar login</button>}
            {c.pending && c.url && <a href={c.url} target="_blank" rel="noreferrer">abrir página de login</a>}
            <button onClick={() => load(true)}>Verificar</button>
          </div>
        </section>
      ))}
    </div>
  );
}
