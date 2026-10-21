import { useState } from 'react';
import { CATEGORY_LABELS } from './Routing.tsx';
import { ROLE_LABELS } from './api.ts';

/** Shown before a run when a routed card is not connected: never fall back to Claude silently. */
export function Preflight({ problems, onRun, onCancel, onConnect }: { problems: any[]; onRun: (overrides: Record<string, string>) => void; onCancel: () => void; onConnect: () => void }) {
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(problems.filter((p) => p.alternative).map((p) => [p.category, p.alternative.id])),
  );
  const blocking = problems.some((p) => !p.alternative && !(p.category in choice));
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pf-title">
      <div className="modal-box">
        <h2 id="pf-title">Algumas IAs não estão conectadas</h2>
        <ul className="pf">
          {problems.map((p) => (
            <li key={p.category}>
              <b>{CATEGORY_LABELS[p.category] ?? ROLE_LABELS[p.category] ?? p.category}</b>: <b>{p.agent.name}</b> não está conectado
              <small className="muted"> ({p.reason})</small>
              {p.alternative ? (
                <label className="check">
                  <input type="checkbox" checked={choice[p.category] === p.alternative.id} onChange={(e) => {
                    const c = { ...choice };
                    e.target.checked ? (c[p.category] = p.alternative.id) : delete c[p.category];
                    setChoice(c);
                  }} />
                  Usar <b>{p.alternative.name}</b> ({p.alternative.model}) só desta vez
                </label>
              ) : (
                <p className="bad">Sem alternativa conectada.</p>
              )}
            </li>
          ))}
        </ul>
        <div className="card-actions">
          <button onClick={onConnect}>Conectar agora</button>
          <button onClick={onCancel}>Cancelar</button>
          <button className="primary" disabled={blocking} onClick={() => onRun(choice)}>Rodar</button>
        </div>
      </div>
    </div>
  );
}
