import { Call, Turn, CallAnalysis } from './models.js';
import { callModel } from './llm.js';
import { POSTCALL_SYSTEM, postcallUser } from './prompts.js';
import { computeMetrics, computeScore } from './metrics.js';
import { STAGE_ORDER } from './playbook.js';
import { autofillCall } from './autofill.js';

const CRITICAL_SCORE = 5;

export async function analyzeCall(callId, liveCostUsd = 0) {
  const call = await Call.findById(callId).populate('playbook_id').lean();
  if (!call) throw new Error('Call não encontrada');

  const turns = await Turn.find({ call_id: callId }).sort({ seq: 1 }).lean();
  if (!turns.length) {
    await Call.findByIdAndUpdate(callId, { status: 'failed' });
    throw new Error('Call sem falas capturadas');
  }

  const playbook = call.playbook_id.definition;
  const metrics  = computeMetrics(turns);
  const { data, costUsd, model: usedModel } = await callModel({
    kind: 'postcall',
    model: process.env.POSTCALL_MODEL,
    system: POSTCALL_SYSTEM,
    user: postcallUser({ playbook, turns }),
    maxTokens: 3000,
  });

  // Regra de evidência: sem fala do lead, "complete" vira "partial".
  const byId = new Map(turns.map((t) => [t.seq, t]));
  const stages = {};
  for (const k of STAGE_ORDER) {
    const st = data.stages?.[k] ?? { status: 'none', reason: '', evidence_turn_ids: [] };
    const hasLead = (st.evidence_turn_ids ?? []).some((id) => byId.get(id)?.role === 'lead');
    stages[k] = st.status === 'complete' && !hasLead
      ? { ...st, status: 'partial', reason: `${st.reason} (sem fala do lead como evidência)` }
      : st;
  }

  const risk     = data.risk_signals ?? [];
  const score    = computeScore(stages, playbook, metrics, risk);
  const observed = STAGE_ORDER.filter((k) => stages[k].status !== 'none').length;

  await CallAnalysis.findOneAndUpdate(
    { call_id: callId },
    {
      call_id:             callId,
      playbook_version:    playbook.version ?? call.playbook_id.version,
      model:               usedModel,
      score,
      stages:              { ...stages, _observed: observed, _total: STAGE_ORDER.length },
      seller_talk_pct:     metrics.seller_talk_pct,
      longest_monologue_s: metrics.longest_monologue_s,
      turn_count:          metrics.turn_count,
      question_count:      metrics.question_count,
      objections:          data.objections ?? [],
      risk_signals:        risk,
      summary:             { ...(data.summary ?? {}), duration_s: metrics.duration_s, longest_lead_monologue_s: metrics.longest_lead_monologue_s },
      next_steps:          data.next_steps ?? [],
      is_critical:         score < CRITICAL_SCORE || risk.some((r) => r.type === 'overpromise'),
      cost_usd:            +(costUsd + liveCostUsd).toFixed(5),
    },
    { upsert: true },
  );
  const lp = data.lead_profile ?? {};
  await autofillCall(callId, { lead_name: lp.name, lead_company: lp.company, lead_role: lp.role }, { onlyIfEmpty: ['lead_name'] });
  await Call.findByIdAndUpdate(callId, { status: 'done' });
  return { score, observed };
}

// Fila em memória com retry (fase 1). Trocar por agenda/BullMQ antes de múltiplos servidores.
const queue = [];
let running = false;

export function enqueueAnalysis(callId, liveCostUsd = 0) {
  queue.push({ callId, liveCostUsd, attempt: 0 });
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await analyzeCall(job.callId, job.liveCostUsd);
    } catch (err) {
      console.error('[analyze]', String(job.callId), err.message);
      if (job.attempt < 2 && err.message !== 'Call sem falas capturadas') {
        job.attempt += 1;
        setTimeout(() => { queue.push(job); void drain(); }, 2000 * 2 ** job.attempt);
      } else {
        await Call.findByIdAndUpdate(job.callId, { status: 'failed' }).catch(() => {});
      }
    }
  }
  running = false;
}
