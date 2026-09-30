import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PRICES = {
  live: { in: +process.env.LIVE_PRICE_IN || 1, out: +process.env.LIVE_PRICE_OUT || 5 },
  postcall: { in: +process.env.POSTCALL_PRICE_IN || 3, out: +process.env.POSTCALL_PRICE_OUT || 15 },
};

export function parseJson(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Resposta do modelo sem JSON');
  return JSON.parse(clean.slice(start, end + 1));
}

// kind: 'live' | 'postcall'
export async function callModel({ kind, model, system, user, maxTokens = 800, json = true }) {
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    // system em bloco com cache: playbook e instruções se repetem em toda chamada da call
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const u = res.usage ?? {};
  const inTok = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) * 0.1;
  const p = PRICES[kind];
  const costUsd = (inTok * p.in + (u.output_tokens ?? 0) * p.out) / 1e6;
  return { data: json ? parseJson(text) : text.trim(), costUsd, usage: u };
}
