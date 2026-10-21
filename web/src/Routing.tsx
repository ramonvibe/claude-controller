import { MODEL_LABELS } from './api.ts';

export const CATEGORY_LABELS: Record<string, string> = {
  architecture: 'Arquitetura / decisões difíceis',
  feature: 'Feature / página seguindo o projeto',
  'small-change': 'Mudança pequena, sem risco',
  tests: 'Testes',
  docs: 'Documentação / README',
};

type Props = { routing: Record<string, string[]>; review: Record<string, boolean>; agents: any[]; onChange: (routing: Record<string, string[]>) => void; onReview: (review: Record<string, boolean>) => void };

export function Routing({ routing, review, agents, onChange, onReview }: Props) {
  const label = (a: any) => `${a.name} · ${MODEL_LABELS[a.model] ?? a.model}`;
  const set = (cat: string, slot: number, id: string) => {
    const cur = [...(routing[cat] ?? [])];
    cur[slot] = id;
    onChange({ ...routing, [cat]: cur.filter(Boolean) });
  };
  return (
    <section className="routing" aria-label="Roteamento por categoria">
      <h2>Quem faz cada tipo de tarefa</h2>
      <p className="muted">O Opus planeja e classifica cada tarefa numa categoria. Se o primeiro card falhar, o reserva assume. Revisão: um revisor confere a entrega contra os critérios de aceite antes de seguir (mais segurança, mais tokens).</p>
      <table>
        <thead><tr><th>Categoria</th><th>Card</th><th>Reserva</th><th>Revisão</th></tr></thead>
        <tbody>
          {Object.entries(CATEGORY_LABELS).map(([cat, text]) => (
            <tr key={cat}>
              <td>{text}</td>
              {[0, 1].map((slot) => (
                <td key={slot}>
                  <select value={routing[cat]?.[slot] ?? ''} onChange={(e) => set(cat, slot, e.target.value)} aria-label={`${text}: ${slot ? 'reserva' : 'card'}`}>
                    <option value="">{slot ? '— nenhum —' : 'automático (pelo papel)'}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>{label(a)}</option>
                    ))}
                  </select>
                </td>
              ))}
              <td>
                <input type="checkbox" checked={review[cat] !== false} onChange={(e) => onReview({ ...review, [cat]: e.target.checked })} aria-label={`${text}: revisar`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
