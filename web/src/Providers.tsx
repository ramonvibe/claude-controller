import { useEffect, useState } from 'react';
import { api } from './api.ts';

export const tierTag = (t?: string | null) => (t === 'free' ? '(free)' : t === 'paga' ? '(paga)' : t === 'assinatura' ? '(assinatura)' : t === 'por modelo' ? '(free/paga por modelo)' : '');

type Catalog = { id: string; label: string; tier: string; kind: string; baseUrl?: string; keyEnv?: string; keyUrl?: string; note: string; keySet: boolean | null };

export function Providers({ onBack, connectors }: { onBack: () => void; connectors: React.ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [draft, setDraft] = useState<any | null>(null);
  const [models, setModels] = useState<{ id: string; free: boolean }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api('GET', '/api/catalog'), api('GET', '/api/providers')])
      .then(([c, p]) => {
        setCatalog(c);
        setProviders(p);
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  const start = (c: Catalog) => {
    setErr('');
    setModels(null);
    setPicked(new Set());
    setDraft({ catalog: c.id, label: c.label, baseUrl: c.baseUrl ?? '', keyEnv: c.keyEnv ?? '', keyUrl: c.keyUrl, note: c.note, tier: c.tier });
  };
  const fetchModels = async () => {
    setBusy(true);
    setErr('');
    try {
      const m = await api('POST', '/api/providers/models', draft);
      setModels(m);
      setPicked(new Set(m.filter((x: any) => x.free).slice(0, 5).map((x: any) => x.id)));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    try {
      await api('POST', '/api/providers', { catalog: draft.catalog, label: draft.label, baseUrl: draft.baseUrl, keyEnv: draft.keyEnv, models: (models ?? []).filter((m) => picked.has(m.id)) });
      setDraft(null);
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const remove = (id: string) => api('DELETE', `/api/providers/${id}`).then(load).catch((e) => setErr(e.message));

  return (
    <div className="app providers">
      <header>
        <h1>Provedores</h1>
        <button className="link" onClick={onBack}>Voltar</button>
      </header>
      {err && <p className="err" role="alert">{err}</p>}

      <h2>Com login próprio</h2>
      {connectors}

      <h2>Adicionados por você</h2>
      {!providers.length && <p className="muted">Nenhum ainda. Escolha um abaixo.</p>}
      <ul className="plist">
        {providers.map((p) => (
          <li key={p.id} className="card idle">
            <strong>{p.label}</strong> {tierTag(catalog.find((c) => c.id === p.catalog)?.tier)}
            <span className={p.keySet ? 'ok' : 'bad'}>{p.keySet ? ' · chave ok' : ` · falta ${p.keyEnv} no .env`}</span>
            <small className="muted"> · {p.models.length} modelo(s): {p.models.map((m: any) => `${m.id}${m.free ? ' (free)' : ''}`).join(', ')}</small>
            <button className="danger" onClick={() => remove(p.id)}>Remover</button>
          </li>
        ))}
      </ul>

      <h2>Adicionar via API</h2>
      <div className="catalog">
        {catalog.map((c) => (
          <button key={c.id} className={`cat ${draft?.catalog === c.id ? 'sel' : ''}`} onClick={() => start(c)}>
            <strong>{c.label}</strong> <span className={`tier ${c.tier === 'free' ? 'free' : 'paid'}`}>{tierTag(c.tier)}</span>
            <small>{c.note}</small>
          </button>
        ))}
      </div>

      {draft && (
        <section className="card idle draft">
          <h2>{draft.label} {tierTag(draft.tier)}</h2>
          <ol className="steps">
            <li>
              Pegue a chave{draft.keyUrl ? <> em <a href={draft.keyUrl} target="_blank" rel="noreferrer">{draft.keyUrl}</a></> : ''}.
            </li>
            <li>
              Adicione ao arquivo <code>.env</code> na pasta do Claude Controller (a chave nunca passa pelo navegador):
              <pre>{`${draft.keyEnv || 'NOME_DA_CHAVE'}=sua-chave-aqui`}</pre>
            </li>
            <li>Clique em <b>Verificar e buscar modelos</b>; não precisa reiniciar.</li>
          </ol>
          <div className="row">
            <label>Nome<input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
            <label>URL base<input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
            <label>Variável da chave<input value={draft.keyEnv} onChange={(e) => setDraft({ ...draft, keyEnv: e.target.value.toUpperCase() })} /></label>
          </div>
          <button className="primary" disabled={busy} onClick={fetchModels}>{busy ? 'Verificando…' : 'Verificar e buscar modelos'}</button>
          {models && (
            <>
              <input placeholder="filtrar modelos…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <div className="models">
                {models.filter((m) => m.id.toLowerCase().includes(filter.toLowerCase())).slice(0, 300).map((m) => (
                  <label key={m.id} className="check">
                    <input
                      type="checkbox"
                      checked={picked.has(m.id)}
                      onChange={(e) => {
                        const n = new Set(picked);
                        e.target.checked ? n.add(m.id) : n.delete(m.id);
                        setPicked(n);
                      }}
                    />
                    {m.id} <span className={`tier ${m.free ? 'free' : 'paid'}`}>{m.free ? '(free)' : '(paga)'}</span>
                    {(m as any).tools === false && <small className="bad"> sem ferramentas: não edita arquivos</small>}
                  </label>
                ))}
              </div>
              <button className="primary" disabled={!picked.size} onClick={save}>Salvar {picked.size} modelo(s)</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}
