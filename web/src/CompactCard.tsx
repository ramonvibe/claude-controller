import { MODEL_LABELS, ROLE_LABELS, fmtTokens } from './api.ts';
import { tierTag } from './Providers.tsx';
import type { CardStatus } from './status.ts';
import type { UsageRow } from './Card.tsx';

const STATUS_LABEL: Record<CardStatus, string> = { running: 'Executando', error: 'Erro', idle: 'Ocioso' };

export function CompactCard({ agent, provider, status, activity, usage, onEdit, onCancel }: {
  agent: any; provider?: { label: string; tier?: string | null; modelTiers?: Record<string, string> }; status: CardStatus; activity?: string; usage: UsageRow[]; onEdit: () => void; onCancel: () => void;
}) {
  const novos = usage.reduce((s, u) => s + u.input + u.cacheCreate, 0);
  const cache = usage.reduce((s, u) => s + u.cacheRead, 0);
  const out = usage.reduce((s, u) => s + u.output, 0);
  const tier = provider?.modelTiers?.[agent.model] ?? provider?.tier;
  return (
    <article className={`card compact ${status} ${agent.enabled ? '' : 'off'}`} aria-label={`${agent.name}: ${STATUS_LABEL[status]}`}>
      <div className="card-head">
        <span className="dot" aria-hidden />
        <strong className="cname">{agent.name}</strong>
        <span className="badge">{agent.enabled ? STATUS_LABEL[status] : 'Desligado'}</span>
      </div>
      <div className="cmeta">
        {ROLE_LABELS[agent.role]} · {MODEL_LABELS[agent.model] ?? agent.model}{agent.effort ? ` ${agent.effort}` : ''}{' '}
        <span className={`tier ${tier === 'free' ? 'free' : 'paid'}`}>{tierTag(tier)}</span>
      </div>
      {status === 'running' && activity && <p className="activity" aria-live="polite">{activity}</p>}
      {usage.length > 0 && <small className="muted tok">{fmtTokens(novos)} novos · {fmtTokens(cache)} cache · {fmtTokens(out)} saída</small>}
      <div className="card-actions">
        {status === 'running' ? <button onClick={onCancel}>Cancelar</button> : <span />}
        <button onClick={onEdit}>Editar</button>
      </div>
    </article>
  );
}
