// Regras puras do motor ao vivo (seção 6). Sem I/O, para testar isoladamente.
import { STAGE_ORDER } from './playbook.js';

const RANK = { none: 0, partial: 1, complete: 2 };

// Verde nunca volta a amarelo; amarelo nunca volta a cinza.
export function mergeStages(current, incoming) {
  const out = {};
  const changes = [];
  for (const k of STAGE_ORDER) {
    const cur = current[k] ?? { status: 'none', reason: '', evidence_turn_ids: [] };
    const inc = incoming?.[k];
    if (inc && RANK[inc.status] !== undefined && RANK[inc.status] > RANK[cur.status]) {
      out[k] = {
        status: inc.status,
        reason: String(inc.reason ?? '').slice(0, 200),
        evidence_turn_ids: Array.isArray(inc.evidence_turn_ids) ? inc.evidence_turn_ids : [],
      };
      changes.push({ stage: k, from: cur.status, to: inc.status });
    } else {
      out[k] = cur;
    }
  }
  return { stages: out, changes };
}

// Só avalia se entrou fala do lead desde a última avaliação, ou se passaram 30 s.
export function shouldEvaluate({ newTurns, lastEvalAt, now, minIntervalMs = 5000, maxIdleMs = 30000 }) {
  if (!newTurns.length) return false;
  if (now - lastEvalAt < minIntervalMs) return false;
  if (newTurns.some((t) => t.role === 'lead')) return true;
  return now - lastEvalAt >= maxIdleMs;
}

// Etapa mais atrasada na ordem S > P > I > CE > D.
export function laggingStage(stages) {
  return STAGE_ORDER.find((k) => stages[k]?.status !== 'complete') ?? null;
}

export function allComplete(stages) {
  return STAGE_ORDER.every((k) => stages[k]?.status === 'complete');
}

// Contagem de falas de evidência por lado, para o tooltip ("6 vendedor · 2 lead").
export function evidenceCounts(stage, turnsById) {
  const c = { seller: 0, lead: 0 };
  for (const id of stage.evidence_turn_ids ?? []) {
    const t = turnsById.get(id);
    if (t?.role === 'lead') c.lead += 1;
    else if (t) c.seller += 1;
  }
  return c;
}

// ─── Contexto ao vivo por etapa ──────────────────────────────────────────────
// knowledge[k] = { context, question_turn_ids, quote_turn_ids }
// O contexto é substituído pelo mais recente não vazio; perguntas e citações acumulam sem repetir.
export function emptyKnowledge() {
  return Object.fromEntries(STAGE_ORDER.map((k) => [k, { context: '', question_turn_ids: [], quote_turn_ids: [] }]));
}

export function mergeKnowledge(current, incoming, turnsById) {
  const out = {};
  const ids = (list, role) => (Array.isArray(list) ? list : [])
    .filter((id) => Number.isInteger(id) && (!turnsById || turnsById.get(id)?.role === role));
  for (const k of STAGE_ORDER) {
    const cur = current?.[k] ?? { context: '', question_turn_ids: [], quote_turn_ids: [] };
    const inc = incoming?.[k] ?? {};
    const context = String(inc.context ?? '').trim().slice(0, 300);
    out[k] = {
      context: context || cur.context,
      question_turn_ids: [...new Set([...cur.question_turn_ids, ...ids(inc.question_turn_ids, 'seller')])].slice(-20),
      quote_turn_ids: [...new Set([...cur.quote_turn_ids, ...ids(inc.quote_turn_ids, 'lead')])].slice(-20),
    };
  }
  return out;
}

// ─── Saúde da call (cor do badge "Ao vivo") ──────────────────────────────────
// level: 'idle' (cinza, sem legendas) | 'risk' (vermelho) | 'warn' (amarelo) | 'good' (verde)
export const HEALTH_RULES = {
  noCaptionsMs: 60_000,        // sem fala nova há 1 min
  riskWindowMs: 5 * 60_000,    // overpromise/objeção nos últimos 5 min
  stallMs: 5 * 60_000,         // nenhuma etapa avançou em 5 min
  sellerTalkMax: 65,           // % de palavras do vendedor
  minTurnsForTalk: 8,
};

export function computeHealth({ now, startedAt, lastTurnAt, captionsFound = true, sellerTalkPct = 0, turnCount = 0,
  lastProgressAt, riskEvents = [] }) {
  const R = HEALTH_RULES;
  const since = (t) => now - (t ?? startedAt);
  if (!captionsFound && since(startedAt) > 15_000) {
    return { level: 'idle', reason: 'Legendas do Meet não encontradas. Ative as legendas (tecla C).' };
  }
  if (since(lastTurnAt) > R.noCaptionsMs) {
    return { level: 'idle', reason: `Nenhuma fala capturada há ${Math.round(since(lastTurnAt) / 60_000) || 1} min.` };
  }
  const recent = riskEvents.filter((e) => now - e.at <= R.riskWindowMs);
  const over = recent.find((e) => e.type === 'overpromise');
  if (over) return { level: 'risk', reason: `Promessa arriscada: ${over.note || 'revise o que foi prometido.'}` };
  const obj = recent.find((e) => e.type === 'objection');
  if (obj) return { level: 'risk', reason: `Objeção do lead: ${obj.note || 'trate antes de avançar.'}` };
  if (turnCount >= R.minTurnsForTalk && sellerTalkPct > R.sellerTalkMax) {
    return { level: 'warn', reason: `Você está falando ${Math.round(sellerTalkPct)}% do tempo. Faça perguntas e ouça.` };
  }
  if (since(lastProgressAt) > R.stallMs) {
    return { level: 'warn', reason: 'Nenhuma etapa avançou nos últimos 5 min.' };
  }
  return { level: 'good', reason: 'Call fluindo: etapas avançando e lead participando.' };
}

// % de palavras do vendedor nas falas até agora (internos contam como lado do vendedor).
export function sellerTalkPct(turns) {
  let seller = 0, total = 0;
  for (const t of turns) {
    const w = t.text.trim() ? t.text.trim().split(/\s+/).length : 0;
    total += w;
    if (t.role !== 'lead') seller += w;
  }
  return total ? (seller / total) * 100 : 0;
}
