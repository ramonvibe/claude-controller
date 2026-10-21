const token = document.querySelector<HTMLMetaElement>('meta[name="cc-token"]')?.content ?? '';

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { 'x-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/** WebSocket that reconnects; `onOpen` runs on every (re)connect so the caller can resync from /api/state. */
export function subscribe(onEvent: (ev: any) => void, onOpen: () => void) {
  let ws: WebSocket;
  let closed = false;
  const connect = () => {
    ws = new WebSocket(`ws://${location.host}/ws?token=${token}`);
    ws.onopen = onOpen;
    ws.onmessage = (m) => onEvent(JSON.parse(m.data));
    ws.onclose = () => !closed && setTimeout(connect, 1000);
  };
  connect();
  return () => {
    closed = true;
    ws.close();
  };
}

export const MODEL_LABELS: Record<string, string> = { opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5' };
export const ROLE_LABELS: Record<string, string> = {
  planner: 'Planejador',
  coder: 'Codificador',
  reviewer: 'Revisor',
  tester: 'Testes',
  docs: 'Documentação',
  custom: 'Personalizado',
};

export function fmtTokens(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
export function fmtUsd(v: number | null | undefined) {
  return v == null ? 'sem preço' : `US$ ${v.toFixed(4)}`;
}
