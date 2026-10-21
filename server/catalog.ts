/** Known third-party providers. "free" = free tier with rate limits; "paga" = pay per token. */
export type CatalogEntry = {
  id: string;
  label: string;
  tier: 'free' | 'paga' | 'por modelo';
  kind: 'openai' | 'cli';
  baseUrl?: string;
  keyEnv?: string;
  keyUrl?: string; // where the user gets a key / logs in
  note: string;
};

export const CATALOG: CatalogEntry[] = [
  { id: 'openrouter', label: 'OpenRouter', tier: 'por modelo', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys', note: 'Modelos com sufixo :free são grátis (com limite diário); os demais são pagos.' },
  { id: 'gemini-api', label: 'Google Gemini API (AI Studio)', tier: 'free', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey', note: 'Camada grátis com limite por minuto/dia.' },
  { id: 'groq', label: 'Groq', tier: 'free', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys', note: 'Camada grátis com limite; muito rápido.' },
  { id: 'cerebras', label: 'Cerebras', tier: 'free', kind: 'openai', baseUrl: 'https://api.cerebras.ai/v1', keyEnv: 'CEREBRAS_API_KEY', keyUrl: 'https://cloud.cerebras.ai', note: 'Camada grátis com limite diário.' },
  { id: 'mistral', label: 'Mistral', tier: 'free', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys', note: 'Plano Experiment grátis com limite.' },
  { id: 'github-models', label: 'GitHub Models', tier: 'free', kind: 'openai', baseUrl: 'https://models.github.ai/inference', keyEnv: 'GITHUB_MODELS_TOKEN', keyUrl: 'https://github.com/settings/tokens', note: 'Grátis com limite; token do GitHub com permissão models:read.' },
  { id: 'deepseek-api', label: 'DeepSeek API', tier: 'paga', kind: 'openai', baseUrl: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys', note: 'Paga por token (barata). Para usar grátis, prefira o DeepSeek via dsh.' },
  { id: 'openai', label: 'OpenAI', tier: 'paga', kind: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys', note: 'Paga por token.' },
  { id: 'xai', label: 'xAI (Grok)', tier: 'paga', kind: 'openai', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', keyUrl: 'https://console.x.ai', note: 'Paga por token.' },
  { id: 'together', label: 'Together AI', tier: 'paga', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY', keyUrl: 'https://api.together.ai/settings/api-keys', note: 'Paga por token.' },
  { id: 'custom', label: 'Outro (compatível com OpenAI)', tier: 'paga', kind: 'openai', note: 'Informe a URL base e o nome da variável da chave.' },
];

/** Built-in CLI providers with their own login (shown with the same tier labels). */
export const CLI_TIERS: Record<string, { tier: 'free' | 'paga' | 'assinatura'; loginNote: string }> = {
  'claude-cli': { tier: 'assinatura', loginNote: 'Login do Claude Code (claude auth login).' },
  dsh: { tier: 'free', loginNote: 'Login com conta DeepSeek/Google pela página do dsh web.' },
  'gemini-cli': { tier: 'free', loginNote: 'Login com conta Google pela própria Gemini CLI.' },
};
