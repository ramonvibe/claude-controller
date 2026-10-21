import { useState } from 'react';
import { MODEL_LABELS, ROLE_LABELS, fmtTokens, fmtUsd } from './api.ts';
import type { CardStatus } from './status.ts';
import { tierTag } from './Providers.tsx';

export type UsageRow = { agentId: string; model: string; input: number; output: number; cacheRead: number; cacheCreate: number; costUsd: number | null; priced: number };

const STATUS_LABEL: Record<CardStatus, string> = { running: 'Executando', error: 'Erro', idle: 'Ocioso' };

type Props = {
  agent: any;
  providers: { id: string; label: string; models: string[]; tier?: string | null; modelTiers?: Record<string, string> }[];
  mcps: { id: string; label: string; kind: string; providers: string[]; available: boolean; schemaTokens: number | null }[];
  status: CardStatus;
  activity?: string;
  usage: UsageRow[];
  canRun: boolean;
  onSave: (a: any) => void;
  onDelete: () => void;
  onRun: () => void;
  onCancel: () => void;
};

export function Card({ agent, providers, mcps, status, activity, usage, canRun, onSave, onDelete, onRun, onCancel }: Props) {
  const [name, setName] = useState(agent.name);
  const save = (patch: object) => onSave({ ...agent, ...patch });
  const tokens = usage.reduce((s, u) => s + u.input + u.output + u.cacheRead + u.cacheCreate, 0);
  const out = usage.reduce((s, u) => s + u.output, 0);
  const priced = usage.some((u) => u.priced);
  const cost = priced ? usage.reduce((s, u) => s + (u.costUsd ?? 0), 0) : null;
  const available = mcps.filter((m) => m.providers.includes(agent.provider) && (m.available || agent.mcps.includes(m.id)));

  return (
    <article className={`card ${status}`} aria-label={`${agent.name}: ${STATUS_LABEL[status]}`}>
      <div className="card-head">
        <span className="dot" aria-hidden />
        <input className="name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== agent.name && save({ name })} aria-label="Nome" />
        <span className="badge">{STATUS_LABEL[status]}</span>
      </div>

      <label>
        Modelo
        <select
          value={`${agent.provider}|${agent.model}`}
          onChange={(e) => {
            const [provider, model] = e.target.value.split('|');
            save({ provider, model });
          }}
        >
          {providers.map((p) => (
            <optgroup key={p.id} label={`${p.label} ${tierTag(p.tier)}`}>
              {p.models.map((m) => (
                <option key={m} value={`${p.id}|${m}`}>{MODEL_LABELS[m] ?? m} {p.modelTiers?.[m] ? tierTag(p.modelTiers[m]) : ''}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label>
        Tipo de Agente
        <select value={agent.role} onChange={(e) => save({ role: e.target.value })}>
          {Object.entries(ROLE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>

      {agent.provider === 'claude-cli' && (
        <label>
          Esforço
          <select value={agent.effort ?? ''} onChange={(e) => save({ effort: e.target.value || null })}>
            <option value="">padrão do modelo</option>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        </label>
      )}

      {available.length > 0 && (
        <fieldset className="mcps">
          <legend>MCPs</legend>
          {available.map((m) => (
            <label key={m.id} className="check" title={m.schemaTokens == null ? 'custo de schema não medido' : `~${m.schemaTokens} tokens por chamada`}>
              <input
                type="checkbox"
                checked={agent.mcps.includes(m.id)}
                onChange={(e) => save({ mcps: e.target.checked ? [...agent.mcps, m.id] : agent.mcps.filter((x: string) => x !== m.id) })}
              />
              {m.label}
              {m.schemaTokens != null && <small> +{fmtTokens(m.schemaTokens)}</small>}
            </label>
          ))}
        </fieldset>
      )}

      {agent.provider === 'claude-cli' && (
        <label className="check" title="Carrega CLAUDE.md, plugins e hooks do usuário (~25k tokens a mais por chamada)">
          <input type="checkbox" checked={agent.inheritUserConfig} onChange={(e) => save({ inheritUserConfig: e.target.checked })} />
          Herdar minha config
        </label>
      )}

      <p className="activity" aria-live="polite">{activity ?? '—'}</p>

      <dl className="usage">
        <div><dt>Tokens</dt><dd>{fmtTokens(tokens)}</dd></div>
        <div><dt>Saída</dt><dd>{fmtTokens(out)}</dd></div>
        <div><dt>Custo (lista)</dt><dd>{usage.length ? fmtUsd(cost) : '—'}</dd></div>
      </dl>

      <div className="card-actions">
        {status === 'running' ? (
          <button onClick={onCancel}>Cancelar</button>
        ) : (
          <button onClick={onRun} disabled={!canRun} title="Roda o pedido só neste agente">Rodar só este</button>
        )}
        <label className="check">
          <input type="checkbox" checked={agent.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
          Ativo
        </label>
        <button className="danger" onClick={onDelete} aria-label={`Remover ${agent.name}`}>Remover</button>
      </div>
    </article>
  );
}
