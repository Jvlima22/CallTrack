import { Call, Turn, CallAnalysis, LiveEvent, LiveState } from './models.js';
import { callModel } from './llm.js';
import { LIVE_SYSTEM, liveUser, SUMMARY_SYSTEM } from './prompts.js';
import { emptyStages } from './playbook.js';
import { mergeStages, shouldEvaluate, laggingStage, allComplete, evidenceCounts } from './liveLogic.js';

const LIVE_ENABLED = process.env.LIVE_ENABLED !== 'false';
const RECENT_WINDOW_MS = 2 * 60 * 1000;
const SUMMARY_EVERY_MS = 3 * 60 * 1000;

const sessions = new Map(); // callId (string) -> session

export function getSession(call, playbook) {
  const key = String(call._id);
  let s = sessions.get(key);
  if (!s) {
    s = {
      callId: call._id,
      playbook: playbook.definition,
      turns: [],
      turnsById: new Map(),
      pending: [],
      stages: emptyStages(),
      summary: '',
      summarizedUpTo: 0,
      lastEvalAt: 0,
      lastSummaryAt: Date.now(),
      evaluating: false,
      costUsd: 0,
      sockets: new Set(),
    };
    sessions.set(key, s);
  }
  return s;
}

export function dropSession(callId) {
  sessions.delete(String(callId));
}

function broadcast(s, msg) {
  const raw = JSON.stringify(msg);
  for (const ws of s.sockets) if (ws.readyState === 1) ws.send(raw);
}

export async function appendTurns(s, incoming) {
  const fresh = incoming.filter((t) => !s.turnsById.has(t.seq));
  if (!fresh.length) return;

  // upsert em bloco: ignora duplicatas sem lançar erro
  await Turn.bulkWrite(
    fresh.map((t) => ({
      updateOne: {
        filter: { call_id: s.callId, seq: t.seq },
        update: {
          $setOnInsert: {
            call_id:      s.callId,
            seq:          t.seq,
            speaker_name: t.speaker_name ?? null,
            role:         t.role,
            text:         t.text,
            started_ms:   t.started_ms,
            ended_ms:     t.ended_ms,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  for (const t of fresh) {
    s.turns.push(t);
    s.turnsById.set(t.seq, t);
    s.pending.push(t);
  }
  s.turns.sort((a, b) => a.seq - b.seq);
  if (LIVE_ENABLED) void maybeEvaluate(s);
}

async function maybeEvaluate(s) {
  const now = Date.now();
  if (s.evaluating) return;
  if (!shouldEvaluate({ newTurns: s.pending, lastEvalAt: s.lastEvalAt, now })) return;
  s.evaluating = true;
  s.lastEvalAt = now;
  s.pending = [];
  try {
    if (now - s.lastSummaryAt > SUMMARY_EVERY_MS) await refreshSummary(s);
    const lastMs = s.turns.at(-1)?.ended_ms ?? 0;
    const recentTurns = s.turns.filter((t) => t.ended_ms >= lastMs - RECENT_WINDOW_MS);

    const { data, costUsd } = await callModel({
      kind: 'live',
      model: process.env.LIVE_MODEL,
      system: LIVE_SYSTEM,
      user: liveUser({ playbook: s.playbook, stages: s.stages, summary: s.summary, recentTurns }),
      maxTokens: 600,
    });
    s.costUsd += costUsd;

    const { stages, changes } = mergeStages(s.stages, data.stages);
    s.stages = stages;
    const at = lastMs;
    const events = [];
    for (const c of changes) events.push({ call_id: s.callId, at_ms: at, type: 'stage_change', payload: c });
    for (const sig of data.signals ?? []) {
      if (['objection', 'case_request', 'overpromise'].includes(sig.type)) {
        events.push({ call_id: s.callId, at_ms: at, type: sig.type, payload: sig });
      }
    }

    let suggestion = null;
    if (data.suggestion?.text && !allComplete(stages)) {
      suggestion = { stage: data.suggestion.stage ?? laggingStage(stages), text: data.suggestion.text };
      events.push({ call_id: s.callId, at_ms: at, type: 'suggestion', payload: suggestion });
    }

    if (events.length) await LiveEvent.insertMany(events);
    await LiveState.findOneAndUpdate(
      { call_id: s.callId },
      { stages: s.stages, rolling_summary: s.summary, updated_at: new Date() },
      { upsert: true },
    );

    broadcast(s, {
      type: 'stages.update',
      stages: Object.fromEntries(
        Object.entries(s.stages).map(([k, v]) => [k, { ...v, counts: evidenceCounts(v, s.turnsById) }]),
      ),
      changes,
    });
    if (suggestion) broadcast(s, { type: 'suggestion.new', suggestion });
    if ((data.signals ?? []).some((x) => x.type === 'case_request')) {
      broadcast(s, { type: 'case.request' });
    }
  } catch (err) {
    broadcast(s, { type: 'error', message: 'Falha ao avaliar a call; a captura continua.' });
    console.error('[live]', String(s.callId), err.message);
  } finally {
    s.evaluating = false;
    if (s.pending.length) setTimeout(() => void maybeEvaluate(s), 5000);
  }
}

async function refreshSummary(s) {
  const newer = s.turns.filter((t) => t.seq > s.summarizedUpTo);
  if (!newer.length) return;
  const { data, costUsd } = await callModel({
    kind: 'live',
    model: process.env.LIVE_MODEL,
    system: SUMMARY_SYSTEM,
    user: `<resumo_atual>${s.summary}</resumo_atual>\n<novas_falas>\n${newer
      .map((t) => `${t.role}: ${t.text}`).join('\n')}\n</novas_falas>`,
    maxTokens: 500,
    json: false,
  });
  s.costUsd += costUsd;
  s.summary = data;
  s.summarizedUpTo = newer.at(-1).seq;
  s.lastSummaryAt = Date.now();
}
