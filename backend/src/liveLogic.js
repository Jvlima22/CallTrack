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
