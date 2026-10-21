import { useState } from 'react';
import { fmtTokens } from './api.ts';

export type SkillInfo = { id: string; name: string; description: string; source: string; tokens: number };

/** Checklist of skills with the per-call token cost of the selection. */
export function SkillPicker({ all, value, onChange }: { all: SkillInfo[]; value: string[]; onChange: (ids: string[]) => void }) {
  const [filter, setFilter] = useState('');
  const total = all.filter((s) => value.includes(s.id)).reduce((n, s) => n + s.tokens, 0);
  const shown = all.filter((s) => `${s.id} ${s.description}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="skills">
      <div className="skills-head">
        <input placeholder="filtrar skills…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar skills" />
        <span className="meter" title="Somado ao prompt de cada chamada do agente">+{fmtTokens(total)} tokens/chamada</span>
      </div>
      <div className="skills-list">
        {shown.map((s) => (
          <label key={s.id} className="check" title={s.description}>
            <input type="checkbox" checked={value.includes(s.id)} onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))} />
            {s.id} <small className="muted">~{fmtTokens(s.tokens)}</small>
          </label>
        ))}
        {!shown.length && <span className="muted">Nenhuma skill encontrada.</span>}
      </div>
    </div>
  );
}

export function DefaultSkills({ all, value, onChange }: { all: SkillInfo[]; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <details className="routing">
      <summary><h2>Skills padrão para todos os agentes ({value.length})</h2></summary>
      <p className="muted">O texto de cada skill marcada entra no prompt de todos os agentes (Claude, DeepSeek, Gemini e APIs). Cada card pode trocar por uma lista própria.</p>
      <SkillPicker all={all} value={value} onChange={onChange} />
    </details>
  );
}
