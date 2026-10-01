import { Call, Turn, LiveEvent, LiveState, User } from './models.js';
import { callModel, llmProvider } from './llm.js';
import { LIVE_SYSTEM, liveUser, SUMMARY_SYSTEM } from './prompts.js';
import { emptyStages } from './playbook.js';
import {
  mergeStages, shouldEvaluate, laggingStage, allComplete, evidenceCounts,
  emptyKnowledge, mergeKnowledge, computeHealth, sellerTalkPct, cleanName, sameName,
} from './liveLogic.js';
import { autofillCall } from './autofill.js';

const LIVE_ENABLED = process.env.LIVE_ENABLED !== 'false';
const RECENT_WINDOW_MS = 2 * 60 * 1000;
const SUMMARY_EVERY_MS = 3 * 60 * 1000;
const PERSIST_EVERY_MS = 10 * 1000;       // participantes e última atividade
const SELF_LABELS = ['você', 'you'];

const sessions = new Map(); // callId (string) -> session

export function getSession(call, playbook) {
  const key = String(call._id);
  let s = sessions.get(key);
  if (!s) {
    const startedAt = new Date(call.started_at ?? Date.now()).getTime();
    s = {
      callId: call._id,
      orgId: call.org_id,
      playbook: playbook.definition,
      startedAt,
      turns: [],
      turnsById: new Map(),
      pending: [],
      stages: emptyStages(),
      knowledge: emptyKnowledge(),
      summary: '',
      summarizedUpTo: 0,
      lastEvalAt: 0,
      lastSummaryAt: Date.now(),
      evaluating: false,
      costUsd: 0,
      sockets: new Set(),
      // saúde da call
      lastTurnAt: null,
      lastProgressAt: startedAt,
      riskEvents: [],
      capture: { captionsFound: true, at: Date.now() },
      // participantes: nome -> dados (nomes antigos salvos repetidos são limpos aqui)
      sellerId: call.seller_id,
      sellerName: null,
      selfName: null,
      participants: new Map((call.participants ?? []).map((p) => [cleanName(p.name), { ...p, name: cleanName(p.name) }])),
      internalNames: null,
      dirty: (call.participants ?? []).some((p) => cleanName(p.name) !== p.name),
      lastPersistAt: 0,
      hydrated: false,
    };
    sessions.set(key, s);
  }
  return s;
}

// Depois de um reinício do servidor, recarrega do banco o que a call já tinha.
export async function hydrateSession(s) {
  if (s.hydrated) return s;
  s.hydrated = true;
  const [turns, state] = await Promise.all([
    Turn.find({ call_id: s.callId }).sort({ seq: 1 }).lean(),
    LiveState.findOne({ call_id: s.callId }).lean(),
  ]);
  for (const t of turns) {
    if (s.turnsById.has(t.seq)) continue;
    s.turns.push(t);
    s.turnsById.set(t.seq, t);
  }
  s.turns.sort((a, b) => a.seq - b.seq);
  if (s.turns.length) s.lastTurnAt = s.startedAt + s.turns.at(-1).ended_ms;
  if (state?.stages) s.stages = { ...s.stages, ...state.stages };
  if (state?.knowledge) s.knowledge = mergeKnowledge(s.knowledge, state.knowledge);
  if (state?.rolling_summary) s.summary = state.rolling_summary;
  return s;
}

export function findSession(callId) {
  return sessions.get(String(callId)) ?? null;
}

export function dropSession(callId) {
  sessions.delete(String(callId));
}

function broadcast(s, msg) {
  const raw = JSON.stringify(msg);
  for (const ws of s.sockets) if (ws.readyState === 1) ws.send(raw);
}

// ─── Saúde (cor do badge "Ao vivo" no CRM) ───────────────────────────────────
export function sessionHealth(s) {
  const h = computeHealth({
    now: Date.now(),
    startedAt: s.startedAt,
    lastTurnAt: s.lastTurnAt,
    captionsFound: s.capture.captionsFound,
    sellerTalkPct: sellerTalkPct(s.turns),
    turnCount: s.turns.length,
    lastProgressAt: s.lastProgressAt,
    riskEvents: s.riskEvents,
  });
  return { ...h, at: new Date() };
}

// ─── Participantes ───────────────────────────────────────────────────────────
async function internalNames(s) {
  if (!s.internalNames) {
    const users = await User.find({ org_id: s.orgId }, { name: 1 }).lean();
    s.internalNames = new Set(users.map((u) => u.name.trim().toLowerCase()));
    // O vendedor é o dono do token: o nome dele identifica "você" na reunião,
    // mesmo quando o Meet não marca o bloco do próprio usuário.
    s.sellerName = users.find((u) => String(u._id) === String(s.sellerId))?.name ?? null;
    if (!s.selfName && s.sellerName) s.selfName = s.sellerName;
  }
  return s.internalNames;
}

function isSelfLabel(name) {
  return SELF_LABELS.includes(String(name ?? '').trim().toLowerCase());
}

function participantFor(s, rawName, { isSelf = false } = {}) {
  const name = isSelf || isSelfLabel(rawName) ? (s.selfName || cleanName(rawName)) : cleanName(rawName);
  if (!name) return null;
  let p = s.participants.get(name);
  if (!p) {
    // "Você" pode ter chegado pelas legendas antes do nome real: junta os dois
    const alias = isSelf ? [...s.participants.values()].find((x) => isSelfLabel(x.name)) : null;
    if (alias) { s.participants.delete(alias.name); p = { ...alias, name }; }
    else p = { name, talk_ms: 0, turn_count: 0, first_seen_at: new Date() };
    s.participants.set(name, p);
    s.dirty = true;
  }
  return p;
}

async function assignRoles(s) {
  const internal = await internalNames(s);
  // "Você" das legendas vira o vendedor assim que o nome dele é conhecido
  const alias = [...s.participants.values()].find((x) => isSelfLabel(x.name));
  if (alias && s.selfName) {
    const real = s.participants.get(s.selfName);
    s.participants.delete(alias.name);
    if (real) {
      real.talk_ms = (real.talk_ms ?? 0) + (alias.talk_ms ?? 0);
      real.turn_count = (real.turn_count ?? 0) + (alias.turn_count ?? 0);
    } else {
      s.participants.set(s.selfName, { ...alias, name: s.selfName });
    }
    s.dirty = true;
  }
  for (const p of s.participants.values()) {
    const self = p.is_self || isSelfLabel(p.name) || sameName(p.name, s.selfName) || sameName(p.name, s.sellerName);
    const role = self ? 'seller' : internal.has(p.name.toLowerCase()) ? 'internal' : 'lead';
    if (self && !p.is_self) { p.is_self = true; s.dirty = true; }
    if (p.role !== role) { p.role = role; s.dirty = true; }
  }
}

// Lista vinda da extensão: [{ name, avatar_url, is_self }], mais o título da reunião.
export async function updateParticipants(s, { self_name, meeting_title, participants = [] }) {
  if (self_name && typeof self_name === 'string' && cleanName(self_name)) s.selfName = cleanName(self_name);
  const now = new Date();
  const present = new Set();
  await internalNames(s); // garante o nome do vendedor antes de classificar
  for (const raw of participants.slice(0, 100)) {
    if (!raw || typeof raw.name !== 'string') continue;
    const p = participantFor(s, raw.name, { isSelf: !!raw.is_self });
    if (!p) continue;
    present.add(p.name);
    if (raw.is_self) p.is_self = true;
    if (typeof raw.avatar_url === 'string' && /^https:\/\//.test(raw.avatar_url) && p.avatar_url !== raw.avatar_url) {
      p.avatar_url = raw.avatar_url.slice(0, 500);
      s.dirty = true;
    }
    p.last_seen_at = now;
    if (p.left_at) { p.left_at = null; s.dirty = true; }
  }
  // quem estava na lista e sumiu, saiu da reunião
  if (participants.length) {
    for (const p of s.participants.values()) {
      if (!present.has(p.name) && !p.left_at && p.last_seen_at && !isSelfLabel(p.name)) { p.left_at = now; s.dirty = true; }
    }
  }
  await assignRoles(s);
  const lead = [...s.participants.values()].find((p) => p.role === 'lead' && !p.left_at) ?? [...s.participants.values()].find((p) => p.role === 'lead');
  await autofillCall(s.callId, {
    lead_name: lead?.name,
    meeting_title: typeof meeting_title === 'string' ? meeting_title : '',
  });
  await persist(s, true);
}

export function updateCapture(s, { captions_found }) {
  s.capture = { captionsFound: captions_found !== false, at: Date.now() };
}

async function persist(s, force = false) {
  const now = Date.now();
  if (!force && now - s.lastPersistAt < PERSIST_EVERY_MS) return;
  s.lastPersistAt = now;
  const set = { last_activity_at: new Date(now) };
  if (s.dirty) { set.participants = [...s.participants.values()]; s.dirty = false; }
  await Call.updateOne({ _id: s.callId }, { $set: set });
}

// Grava já o que estiver pendente (ao encerrar a call).
export async function flushSession(s) {
  await persist(s, true).catch((e) => console.error('[live] flush', e.message));
}

// Registra atividade (qualquer mensagem da extensão) para o encerramento automático.
export function touch(s) {
  void persist(s).catch((e) => console.error('[live] persist', e.message));
}

// ─── Falas ───────────────────────────────────────────────────────────────────
export async function appendTurns(s, incoming) {
  const fresh = incoming.filter((t) => !s.turnsById.has(t.seq));
  if (!fresh.length) return;

  // Nome real no lugar de "Você"/"You" quando já sabemos quem é o vendedor
  for (const t of fresh) {
    if (t.role === 'seller' && s.selfName && isSelfLabel(t.speaker_name)) t.speaker_name = s.selfName;
  }

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
    const p = participantFor(s, t.speaker_name || (t.role === 'seller' ? 'Você' : ''), { isSelf: t.role === 'seller' });
    if (p) {
      p.talk_ms = (p.talk_ms ?? 0) + Math.max(0, (t.ended_ms ?? 0) - (t.started_ms ?? 0));
      p.turn_count = (p.turn_count ?? 0) + 1;
      p.last_seen_at = new Date();
      s.dirty = true;
    }
  }
  s.turns.sort((a, b) => a.seq - b.seq);
  s.lastTurnAt = Date.now();
  await assignRoles(s);
  await persist(s);
  if (LIVE_ENABLED) void maybeEvaluate(s);
}

// ─── Avaliação ao vivo ───────────────────────────────────────────────────────
async function maybeEvaluate(s) {
  const now = Date.now();
  if (s.evaluating) return;
  // nível gratuito do Gemini limita pedidos por minuto: intervalo mínimo maior entre avaliações
  const minIntervalMs = +process.env.LIVE_MIN_INTERVAL_MS || (llmProvider() === 'gemini' ? 8000 : 5000);
  if (!shouldEvaluate({ newTurns: s.pending, lastEvalAt: s.lastEvalAt, now, minIntervalMs })) return;
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
      maxTokens: 1200,
    });
    s.costUsd += costUsd;

    const { stages, changes } = mergeStages(s.stages, data.stages);
    s.stages = stages;
    s.knowledge = mergeKnowledge(s.knowledge, data.knowledge, s.turnsById);
    if (changes.length) s.lastProgressAt = Date.now();

    const at = lastMs;
    const events = [];
    for (const c of changes) events.push({ call_id: s.callId, at_ms: at, type: 'stage_change', payload: c });
    for (const sig of data.signals ?? []) {
      if (['objection', 'case_request', 'overpromise'].includes(sig.type)) {
        events.push({ call_id: s.callId, at_ms: at, type: sig.type, payload: sig });
        if (sig.type !== 'case_request') s.riskEvents.push({ type: sig.type, at: Date.now(), note: sig.note });
      }
    }

    let suggestion = null;
    if (data.suggestion?.text && !allComplete(stages)) {
      suggestion = { stage: data.suggestion.stage ?? laggingStage(stages), text: data.suggestion.text };
      events.push({ call_id: s.callId, at_ms: at, type: 'suggestion', payload: suggestion });
    }

    const lp = data.lead_profile ?? {};
    await autofillCall(s.callId, { lead_name: lp.name, lead_company: lp.company, lead_role: lp.role }, { onlyIfEmpty: ['lead_name'] });

    if (events.length) await LiveEvent.insertMany(events);
    await LiveState.findOneAndUpdate(
      { call_id: s.callId },
      { stages: s.stages, knowledge: s.knowledge, rolling_summary: s.summary, health: sessionHealth(s), updated_at: new Date() },
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

// Estado ao vivo para o CRM: de memória se a call está rodando neste servidor, senão do banco.
export async function liveSnapshot(call) {
  const s = findSession(call._id);
  if (s) {
    return { stages: s.stages, knowledge: s.knowledge, summary: s.summary, health: sessionHealth(s), connected: s.sockets.size > 0 };
  }
  const st = await LiveState.findOne({ call_id: call._id }).lean();
  const health = call.status === 'live'
    ? { level: 'idle', reason: 'A extensão não está conectada a esta call.', at: new Date() }
    : st?.health ?? null;
  return { stages: st?.stages ?? emptyStages(), knowledge: st?.knowledge ?? emptyKnowledge(), summary: st?.rolling_summary ?? '', health, connected: false };
}
