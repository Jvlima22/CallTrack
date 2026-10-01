// Conversa com a IA. Dois provedores, escolhidos no .env:
//   LLM_PROVIDER=anthropic -> Claude (LIVE_MODEL / POSTCALL_MODEL)
//   LLM_PROVIDER=gemini    -> Google Gemini (GEMINI_LIVE_MODEL / GEMINI_POSTCALL_MODEL)
// Sem LLM_PROVIDER: usa o Claude se ANTHROPIC_API_KEY estiver preenchida, senão o Gemini se GEMINI_API_KEY estiver.
import Anthropic from '@anthropic-ai/sdk';

const PRICES = {
  anthropic: {
    live: { in: +process.env.LIVE_PRICE_IN || 1, out: +process.env.LIVE_PRICE_OUT || 5 },
    postcall: { in: +process.env.POSTCALL_PRICE_IN || 2, out: +process.env.POSTCALL_PRICE_OUT || 10 },
  },
  // nível gratuito do Gemini = custo 0; no plano pago, preencha os preços no .env
  gemini: {
    live: { in: +process.env.GEMINI_LIVE_PRICE_IN || 0, out: +process.env.GEMINI_LIVE_PRICE_OUT || 0 },
    postcall: { in: +process.env.GEMINI_POSTCALL_PRICE_IN || 0, out: +process.env.GEMINI_POSTCALL_PRICE_OUT || 0 },
  },
};

const GEMINI_MODELS = {
  live: process.env.GEMINI_LIVE_MODEL || 'gemini-flash-lite-latest',
  postcall: process.env.GEMINI_POSTCALL_MODEL || 'gemini-flash-latest',
};
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export function llmProvider() {
  const p = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (p === 'anthropic' || p === 'gemini') return p;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'anthropic';
}

export function parseJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Resposta do modelo sem JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

let anthropicClient = null;
async function callAnthropic({ kind, model, system, user, maxTokens }) {
  anthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await anthropicClient.messages.create({
    model,
    max_tokens: maxTokens,
    // system em bloco com cache: playbook e instruções se repetem em toda chamada da call
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const u = res.usage ?? {};
  const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) * 0.1;
  const p = PRICES.anthropic[kind];
  const costUsd = (inTok * p.in + (u.output_tokens ?? 0) * p.out) / 1e6;
  return { text, costUsd, usage: u, model };
}

async function callGemini({ kind, system, user, maxTokens, json }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY não definida no .env');
  const model = GEMINI_MODELS[kind];
  const res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        // modelos que "pensam" gastam parte do limite antes de responder: folga para não cortar o JSON
        maxOutputTokens: Math.max(maxTokens * 4, 4096),
        temperature: 0.2,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    if (res.status === 429) throw new Error(`Gemini: limite do nível gratuito atingido, tente de novo em instantes (${msg})`);
    if (res.status === 404) throw new Error(`Gemini: modelo "${model}" não encontrado. Ajuste GEMINI_${kind === 'live' ? 'LIVE' : 'POSTCALL'}_MODEL no .env (${msg})`);
    throw new Error(`Gemini: ${msg}`);
  }
  const cand = body.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
  if (!text) throw new Error(`Gemini: resposta vazia (${cand?.finishReason || body.promptFeedback?.blockReason || 'sem motivo informado'})`);
  const u = body.usageMetadata ?? {};
  const p = PRICES.gemini[kind];
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  const costUsd = ((u.promptTokenCount ?? 0) * p.in + out * p.out) / 1e6;
  return {
    text, costUsd, model: body.modelVersion || model,
    usage: { input_tokens: u.promptTokenCount, output_tokens: out, finish_reason: cand?.finishReason },
  };
}

// kind: 'live' | 'postcall'. `model` vale para o Claude; no Gemini o modelo vem do .env.
// Retorna { data, costUsd, usage, model } — model = o que de fato respondeu.
export async function callModel({ kind, model, system, user, maxTokens = 800, json = true }) {
  const r = llmProvider() === 'gemini'
    ? await callGemini({ kind, system, user, maxTokens, json })
    : await callAnthropic({ kind, model, system, user, maxTokens });
  return { data: json ? parseJson(r.text) : r.text.trim(), costUsd: r.costUsd, usage: r.usage, model: r.model };
}
