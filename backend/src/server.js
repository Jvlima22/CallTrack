import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { connectDb, userFromToken, defaultPlaybook } from './db.js';
import { Call, Turn, CallAnalysis, LiveEvent, User } from './models.js';
import { AUTOFILL_FIELDS } from './autofill.js';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import {
  getSession, hydrateSession, findSession, appendTurns, dropSession,
  updateParticipants, updateCapture, touch, liveSnapshot, sessionHealth,
} from './live.js';
import { enqueueAnalysis } from './analyze.js';
import { MEET_SELECTORS } from './selectors.js';

await connectDb();

// O token do vendedor pode vir na query do WebSocket; não deixa ele ir para o log.
const redactUrl = (url) => String(url ?? '').replace(/([?&]token=)[^&]*/gi, '$1***');
const app = Fastify({
  logger: {
    serializers: {
      req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
    },
  },
});
await app.register(cors, { origin: true });
await app.register(websocket);

// Interface do CallTrack (atendimentos + CRM das calls) — arquivo único na raiz do repositório.
const CALLTRACK_HTML = fileURLToPath(new URL('../../calltrack.html', import.meta.url));
const IDLE_END_MS = 10 * 60 * 1000;

// ─── Auth helpers ────────────────────────────────────────────────────────────

// Token só no header Authorization. A única exceção é o WebSocket, porque o
// navegador não deixa definir headers no handshake — ali ele vem em ?token=.
async function auth(req, reply) {
  let token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!token && req.headers.upgrade?.toLowerCase() === 'websocket') token = req.query?.token;
  const user = await userFromToken((token || '').trim());
  if (!user) return reply.code(401).send({ error: 'Token inválido. Gere um novo token com npm run seed.' });
  req.user = user;
}

// Quem o usuário pode ver: vendedor só as próprias calls, gestor as do time, admin a conta toda.
async function visibleSellerFilter(u) {
  if (u.role === 'admin') return {};
  if (u.role === 'manager' && u.team_id) {
    const team = await User.find({ org_id: u.org_id, team_id: u.team_id }, { _id: 1 }).lean();
    return { seller_id: { $in: team.map((s) => s._id) } };
  }
  return { seller_id: u._id };
}

async function loadOwnedCall(req, reply) {
  const call = await Call.findById(req.params.id).lean();
  if (!call) return reply.code(404).send({ error: 'Call não encontrada.' });
  const u = req.user;
  const isOwner = String(call.seller_id) === String(u._id);
  const isAdmin  = u.role === 'admin'   && String(call.org_id) === String(u.org_id);
  let isManager  = false;
  if (u.role === 'manager') {
    const seller = await User.findById(call.seller_id).lean();
    isManager = seller && String(seller.team_id) === String(u.team_id);
  }
  if (!isOwner && !isAdmin && !isManager) return reply.code(403).send({ error: 'Sem acesso a esta call.' });
  req.call = call;
}

// ─── Encerrar call (DRY) ─────────────────────────────────────────────────────

async function endCall(callId) {
  const call = await Call.findById(callId).populate('playbook_id').lean();
  if (!call || call.status !== 'live') return call;

  const session = getSession(call, call.playbook_id);
  await Call.findByIdAndUpdate(callId, { ended_at: new Date(), status: 'processing' });
  for (const ws of session.sockets) ws.close(1000, 'call encerrada');
  enqueueAnalysis(callId, session.costUsd);
  dropSession(callId);
  return call;
}

// ─── Rotas ───────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true }));

app.get('/', async (req, reply) => reply.type('text/html; charset=utf-8').send(await readFile(CALLTRACK_HTML)));
app.get('/dashboard', async (req, reply) => reply.redirect('/'));
app.get('/dashboard/', async (req, reply) => reply.redirect('/'));

// Seletores do DOM do Meet — a extensão busca a cada call para não precisar ser republicada.
app.get('/config/meet-selectors', async () => MEET_SELECTORS);

// GET /api/crm/calls — calls visíveis ao usuário, com análise e nome do vendedor (CRM)
app.get('/api/crm/calls', { preHandler: auth }, async (req) => {
  const calls = await Call.find({ org_id: req.user.org_id, ...(await visibleSellerFilter(req.user)) })
    .sort({ started_at: -1 })
    .lean();
  
  const callIds = calls.map(c => c._id);
  const analyses = await CallAnalysis.find({ call_id: { $in: callIds } }).lean();
  const analysesByCall = new Map(analyses.map(a => [String(a.call_id), a]));
  
  const sellers = await User.find({ org_id: req.user.org_id }).lean();
  const sellersById = new Map(sellers.map(s => [String(s._id), s]));

  return calls.map((c) => {
    const s = c.status === 'live' ? findSession(c._id) : null;
    return {
      ...c,
      seller_name: sellersById.get(String(c.seller_id))?.name || 'Vendedor',
      analysis: analysesByCall.get(String(c._id)) || null,
      live_health: c.status !== 'live' ? null
        : s ? sessionHealth(s) : { level: 'idle', reason: 'A extensão não está conectada a esta call.' },
    };
  });
});

// POST /calls — inicia uma call
app.post('/calls', { preHandler: auth }, async (req, reply) => {
  const { meeting_code, lead_name, lead_company } = req.body ?? {};
  const playbook = await defaultPlaybook(req.user.org_id);
  if (!playbook) return reply.code(400).send({ error: 'Nenhum playbook padrão configurado para a conta.' });

  const call = await Call.create({
    org_id:       req.user.org_id,
    seller_id:    req.user._id,
    playbook_id:  playbook._id,
    meeting_code: meeting_code ?? null,
    lead_name:    lead_name ?? null,
    lead_company: lead_company ?? null,
    last_activity_at: new Date(),
  });
  return {
    call_id:     String(call._id),
    seller_name: req.user.name,
    playbook:    { name: playbook.name, version: playbook.version, stages: playbook.definition.stages },
  };
});

// POST /calls/:id/end
app.post('/calls/:id/end', { preHandler: [auth, loadOwnedCall] }, async (req) => {
  await endCall(req.call._id);
  return { ok: true, status: 'processing' };
});

// GET /calls/:id — retorna call completa com turns, análise e eventos
app.get('/calls/:id', { preHandler: [auth, loadOwnedCall] }, async (req) => {
  const [turns, analysis, events] = await Promise.all([
    Turn.find({ call_id: req.call._id }).sort({ seq: 1 }).lean(),
    CallAnalysis.findOne({ call_id: req.call._id }).lean(),
    LiveEvent.find({ call_id: req.call._id }).sort({ at_ms: 1 }).lean(),
  ]);
  return { call: req.call, turns, analysis, events };
});

// GET /calls/:id/live?since=<seq> — estado em tempo real para o CRM:
// etapas com contexto/perguntas/citações, saúde da call, participantes e as falas novas desde <seq>.
app.get('/calls/:id/live', { preHandler: [auth, loadOwnedCall] }, async (req) => {
  const since = Number.isInteger(+req.query?.since) ? +req.query.since : -1;
  const [live, turns, events] = await Promise.all([
    liveSnapshot(req.call),
    Turn.find({ call_id: req.call._id, seq: { $gt: since } }).sort({ seq: 1 }).limit(500).lean(),
    LiveEvent.find({ call_id: req.call._id }).sort({ at_ms: 1 }).lean(),
  ]);
  return { call: req.call, live, turns, events, server_time: new Date() };
});

// PATCH /calls/:id — atualiza metadados da call
app.patch('/calls/:id', { preHandler: [auth, loadOwnedCall] }, async (req, reply) => {
  const allowed = ['lead_name', 'lead_company', 'lead_role', 'meeting_title', 'crm_deal_id', 'outcome'];
  const patch = Object.fromEntries(Object.entries(req.body ?? {})
    .filter(([k, v]) => allowed.includes(k) && (v === null || typeof v === 'string'))
    .map(([k, v]) => [k, typeof v === 'string' ? v.trim().slice(0, 200) : v]));
  if (patch.outcome && !['won', 'lost', 'open'].includes(patch.outcome)) {
    return reply.code(400).send({ error: 'outcome deve ser won, lost ou open.' });
  }
  // Campo alterado à mão deixa de ser preenchido automaticamente.
  const manual = AUTOFILL_FIELDS.filter((k) => k in patch && (patch[k] ?? '') !== (req.call[k] ?? ''));
  const update = { $set: patch };
  if (manual.length) update.$addToSet = { manual_fields: { $each: manual } };
  const updated = await Call.findByIdAndUpdate(req.call._id, update, { returnDocument: 'after' }).lean();
  return updated;
});

// GET /ws/calls/:id — WebSocket da call
app.get('/ws/calls/:id', { websocket: true, preHandler: [auth, loadOwnedCall] }, async (socket, req) => {
  const call = await Call.findById(req.params.id).populate('playbook_id').lean();
  if (!call || call.status !== 'live') {
    socket.send(JSON.stringify({ type: 'error', message: 'Esta call já foi encerrada.' }));
    return socket.close();
  }
  const session = await hydrateSession(getSession(call, call.playbook_id));
  session.sockets.add(socket);
  socket.send(JSON.stringify({ type: 'stages.update', stages: session.stages, changes: [] }));

  socket.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    touch(session);
    try {
      if (msg.type === 'turns.append' && Array.isArray(msg.turns)) {
        const valid = msg.turns.filter(
          (t) => Number.isInteger(t.seq) && ['seller', 'lead', 'internal'].includes(t.role) && typeof t.text === 'string' && t.text.trim(),
        );
        await appendTurns(session, valid);
        // confirma também as inválidas, senão a extensão reenviaria para sempre
        const upTo = Math.max(...msg.turns.map((t) => (Number.isInteger(t.seq) ? t.seq : -1)), -1);
        socket.send(JSON.stringify({ type: 'turns.ack', upTo }));
      } else if (msg.type === 'participants.update') {
        await updateParticipants(session, msg);
      } else if (msg.type === 'capture.status') {
        updateCapture(session, msg);
      }
    } catch (err) {
      req.log.error(err);
      if (msg.type === 'turns.append') {
        socket.send(JSON.stringify({ type: 'error', message: 'Falas não salvas; a extensão vai reenviar.' }));
      }
    }
  });
  socket.on('close', () => session.sockets.delete(socket));
});

// Encerra calls esquecidas (aba fechada sem clicar "Encerrar call", ou servidor reiniciado no meio).
// A última atividade fica no banco, então isso vale também para calls de antes de um reinício.
async function endIdleCalls() {
  const limit = new Date(Date.now() - IDLE_END_MS);
  const stale = await Call.find({
    status: 'live',
    $or: [{ last_activity_at: { $lt: limit } }, { last_activity_at: null, started_at: { $lt: limit } }],
  }, { _id: 1 }).lean();
  for (const c of stale) {
    const s = findSession(c._id);
    if (s && s.sockets.size) continue; // extensão ainda conectada
    await endCall(c._id).catch((e) => app.log.error(e));
  }
}
await endIdleCalls().catch((e) => app.log.error(e));
setInterval(() => endIdleCalls().catch((e) => app.log.error(e)), 60 * 1000);

await app.listen({ port: +process.env.PORT || 8787, host: '0.0.0.0' });
