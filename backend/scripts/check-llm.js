// Confere a IA configurada no .env: provedor, modelos e uma avaliação de verdade com
// um trecho do roteiro de teste (Mariana, Transportadora Veloz).
// Uso: npm run llm:check
import 'dotenv/config';
import { callModel, llmProvider } from '../src/llm.js';
import { LIVE_SYSTEM, liveUser, POSTCALL_SYSTEM, postcallUser } from '../src/prompts.js';
import { DEFAULT_SPICED, emptyStages } from '../src/playbook.js';

const provider = llmProvider();
console.log(`Provedor: ${provider}`);

if (provider === 'gemini') {
  if (!process.env.GEMINI_API_KEY) { console.error('GEMINI_API_KEY vazia no backend/.env'); process.exit(1); }
  const live = process.env.GEMINI_LIVE_MODEL || 'gemini-flash-lite-latest';
  const post = process.env.GEMINI_POSTCALL_MODEL || 'gemini-flash-latest';
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
  const body = await r.json();
  if (!r.ok) { console.error('Chave recusada pelo Google:', body?.error?.message); process.exit(1); }
  const names = new Set((body.models ?? []).map((m) => m.name.replace(/^models\//, '')));
  for (const [label, m] of [['ao vivo', live], ['pós-call', post]]) {
    console.log(`Modelo ${label}: ${m} ${names.has(m) ? '(disponível)' : '(NÃO encontrado)'}`);
  }
  if (!names.has(live) || !names.has(post)) {
    console.log('Modelos "flash" disponíveis para esta chave:', [...names].filter((n) => /flash/.test(n)).join(', '));
  }
} else if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY vazia. Para usar o Gemini, preencha GEMINI_API_KEY no backend/.env.');
  process.exit(1);
}

const turns = [
  ['seller', 'Josué Lima', 'Pra eu te conhecer melhor, pode se apresentar e contar um pouco da empresa?'],
  ['lead', 'Mariana Souza', 'Eu sou a Mariana Souza, diretora de operações da Transportadora Veloz. A gente faz transporte e distribuição para o varejo.'],
  ['seller', 'Josué Lima', 'E qual o tamanho da operação de vocês hoje?'],
  ['lead', 'Mariana Souza', 'Hoje são 180 caminhões e quatro centros de distribuição. Fazemos em média 3.200 entregas por dia.'],
  ['seller', 'Josué Lima', 'E como funciona hoje a roteirização dessas entregas?'],
  ['lead', 'Mariana Souza', 'É tudo na planilha. Uma equipe de 14 pessoas monta as rotas todo dia de madrugada.'],
].map(([role, speaker_name, text], seq) => ({ seq, role, speaker_name, text, started_ms: seq * 15000, ended_ms: seq * 15000 + 12000 }));

const t0 = Date.now();
const live = await callModel({
  kind: 'live', model: process.env.LIVE_MODEL, system: LIVE_SYSTEM,
  user: liveUser({ playbook: DEFAULT_SPICED, stages: emptyStages(), summary: '', recentTurns: turns }), maxTokens: 1200,
});
console.log(`\nAvaliação ao vivo (${live.model}, ${Date.now() - t0} ms):`);
console.log('  Etapas:', Object.entries(live.data.stages ?? {}).map(([k, v]) => `${k}=${v?.status}`).join(' '));
console.log('  Contexto de S:', live.data.knowledge?.S?.context || '(vazio)');
console.log('  Perguntas de S:', JSON.stringify(live.data.knowledge?.S?.question_turn_ids ?? []), '· citações:', JSON.stringify(live.data.knowledge?.S?.quote_turn_ids ?? []));
console.log('  Lead:', JSON.stringify(live.data.lead_profile ?? {}));
console.log('  Sugestão:', live.data.suggestion?.text || '(nenhuma)');

const t1 = Date.now();
const post = await callModel({ kind: 'postcall', model: process.env.POSTCALL_MODEL, system: POSTCALL_SYSTEM, user: postcallUser({ playbook: DEFAULT_SPICED, turns }), maxTokens: 3000 });
console.log(`\nAnálise pós-call (${post.model}, ${Date.now() - t1} ms):`);
console.log('  Situação:', post.data.summary?.situation || '(vazio)');
console.log('  Próximos passos:', (post.data.next_steps ?? []).map((n) => n.text).join(' | ') || '(nenhum)');
console.log(`\nCusto estimado do teste: US$ ${(live.costUsd + post.costUsd).toFixed(4)}`);

const ok = live.data.stages?.S?.status && live.data.stages.S.status !== 'none' && /veloz/i.test(live.data.lead_profile?.company ?? '');
console.log(ok ? '\nOK: a IA está respondendo no formato que o CallTrack espera.' : '\nATENÇÃO: a resposta veio, mas sem a etapa S ou a empresa do lead. Veja os valores acima.');
process.exit(ok ? 0 : 2);
