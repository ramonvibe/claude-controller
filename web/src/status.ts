// Card color state, derived only from backend snapshot + WebSocket events (no polling).
export type CardStatus = 'running' | 'error' | 'idle';
export type Live = { running: { id: string; agentId: string }[]; last: { agentId: string; status: string }[] };
export type StatusState = { running: Record<string, string[]>; error: Record<string, boolean> };

export function fromSnapshot(live: Live): StatusState {
  const s: StatusState = { running: {}, error: {} };
  for (const t of live.running) (s.running[t.agentId] ??= []).push(t.id);
  for (const l of live.last) if (l.status === 'error' && !s.running[l.agentId]) s.error[l.agentId] = true;
  return s;
}

export function applyEvent(s: StatusState, ev: { kind: string; agentId: string | null; taskId: string | null }): StatusState {
  const a = ev.agentId;
  const t = ev.taskId;
  if (!a || !t) return s;
  const tasks = s.running[a] ?? [];
  if (ev.kind === 'started')
    return { running: { ...s.running, [a]: [...tasks.filter((x) => x !== t), t] }, error: { ...s.error, [a]: false } };
  if (ev.kind === 'result' || ev.kind === 'error')
    return {
      running: { ...s.running, [a]: tasks.filter((x) => x !== t) },
      error: ev.kind === 'error' ? { ...s.error, [a]: true } : s.error,
    };
  return s;
}

export function cardStatus(s: StatusState, agentId: string): CardStatus {
  if (s.running[agentId]?.length) return 'running';
  return s.error[agentId] ? 'error' : 'idle';
}
