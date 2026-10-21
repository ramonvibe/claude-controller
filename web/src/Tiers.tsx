import { useState } from 'react';
import { MODEL_LABELS } from './api.ts';
import { CATEGORY_LABELS } from './Routing.tsx';

export type Tier = { id: string; label: string; role: 'coder' | 'tester' | 'docs'; category: string; when: string; agents: string[]; review: boolean; enabled: boolean; escalateTo?: string };

const ROLES: Record<Tier['role'], string> = { coder: 'Programador', tester: 'Testador', docs: 'Documentação' };

type Props = { tiers: Tier[]; agents: any[]; onChange: (t: Tier[]) => void };

const slug = (s: string) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31).replace(/-+$/, '');

export function Tiers({ tiers, agents, onChange }: Props) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const label = (a: any) => `${a.name} · ${MODEL_LABELS[a.model] ?? a.model}`;
  const taken = (id: string, except?: number) => tiers.some((t, j) => j !== except && t.id === id);
  const patch = (i: number, p: Partial<Tier>) => onChange(tiers.map((t, j) => (j === i ? { ...t, ...p } : t)));
  const rename = (i: number, id: string) => {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) return setError('Ferramenta: minúsculas, números e "-", começando por letra');
    if (taken(id, i)) return setError(`Já existe um nível com a ferramenta "${id}"`);
    setError('');
    patch(i, { id });
  };
  const setAgent = (i: number, slot: number, id: string) => {
    const cur = [...tiers[i].agents];
    cur[slot] = id;
    patch(i, { agents: cur.filter(Boolean) });
  };
  const add = () => {
    const id = slug(name);
    if (!/^[a-z]/.test(id)) return setError('Dê um nome com letras para o nível');
    if (taken(id)) return setError(`Já existe um nível com a ferramenta "${id}"`);
    setError('');
    setName('');
    onChange([...tiers, { id, label: name.trim(), role: 'coder', category: 'feature', when: '', agents: [], review: true, enabled: true }]);
  };
  return (
    <section className="routing tiers" aria-label="Níveis de delegação">
      <h2>Níveis de delegação</h2>
      <p className="muted">O planejador escolhe um nível para cada tarefa e a ferramenta MCP do nível já fixa papel e categoria. Card e reserva funcionam como em Roteamento. Escala para: nível tentado antes do planejador quando este falha.</p>
      {error && <p className="err" role="alert">{error}</p>}
      <table>
        <thead><tr><th>Ativo</th><th>Nome</th><th>Ferramenta</th><th>Papel</th><th>Categoria</th><th>Quando usar</th><th>Card</th><th>Reserva</th><th>Revisão</th><th>Escala para</th><th></th></tr></thead>
        <tbody>
          {tiers.map((t, i) => (
            <tr key={t.id}>
              <td>
                <input type="checkbox" checked={t.enabled} onChange={(e) => patch(i, { enabled: e.target.checked })} aria-label={`${t.label}: ativo`} />
              </td>
              <td>
                <input defaultValue={t.label} onBlur={(e) => e.target.value !== t.label && patch(i, { label: e.target.value })} aria-label={`Nível ${i + 1}: nome`} />
              </td>
              <td>
                <input defaultValue={t.id} onBlur={(e) => e.target.value !== t.id && rename(i, e.target.value)} aria-label={`${t.label}: ferramenta`} title="Nome da ferramenta MCP: minúsculas, números e '-'" />
              </td>
              <td>
                <select value={t.role} onChange={(e) => patch(i, { role: e.target.value as Tier['role'] })} aria-label={`${t.label}: papel`}>
                  {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </td>
              <td>
                <select value={t.category} onChange={(e) => patch(i, { category: e.target.value })} aria-label={`${t.label}: categoria`}>
                  {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </td>
              <td>
                <textarea rows={2} defaultValue={t.when} onBlur={(e) => e.target.value !== t.when && patch(i, { when: e.target.value })} aria-label={`${t.label}: quando usar`} />
              </td>
              {[0, 1].map((slot) => (
                <td key={slot}>
                  <select value={t.agents[slot] ?? ''} onChange={(e) => setAgent(i, slot, e.target.value)} aria-label={`${t.label}: ${slot ? 'reserva' : 'card'}`}>
                    <option value="">{slot ? '— nenhum —' : 'automático (pelo papel)'}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{label(a)}</option>
                    ))}
                  </select>
                </td>
              ))}
              <td>
                <input type="checkbox" checked={t.review} onChange={(e) => patch(i, { review: e.target.checked })} aria-label={`${t.label}: revisar`} />
              </td>
              <td>
                <select value={t.escalateTo ?? ''} onChange={(e) => patch(i, { escalateTo: e.target.value || undefined })} aria-label={`${t.label}: escala para`}>
                  <option value="">Planejador</option>
                  {tiers.filter((o) => o.id !== t.id).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </td>
              <td>
                <button onClick={() => onChange(tiers.filter((_, j) => j !== i).map((o) => (o.escalateTo === t.id ? { ...o, escalateTo: undefined } : o)))} aria-label={`Remover ${t.label}`}>Remover</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="tier-add">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do novo nível" aria-label="Nome do novo nível" />
        <button onClick={add} aria-label="Adicionar nível">Adicionar nível</button>
      </div>
    </section>
  );
}
