// Rotas da gravação de vídeo das calls.
// Fluxo: extensão chama /start (com o aviso de gravação confirmado) -> envia pedaços a cada 10 s -> /finish.
// O CRM pede /recording (ficha + link assinado de 1 h) e o player lê /recordings/:id/stream por faixas.
import crypto from 'node:crypto';
import { Recording, RecordingAudit, audit, RETENTION_BASES } from './recordingModels.js';
import { writeChunk, finalize, fileInfo, readRange, removeRecording } from './storage.js';

const SIGN_SECRET = process.env.RECORDING_SIGNING_SECRET || crypto.randomBytes(32).toString('hex');
const URL_TTL_S = 60 * 60;
const MAX_CHUNK_BYTES = 30 * 1024 * 1024;
export const CONSENT_TEXT = 'Aviso: esta call está sendo gravada. O registro será mantido como prova da negociação e para cumprimento de obrigações legais.';

const sign = (rid, exp) => crypto.createHmac('sha256', SIGN_SECRET).update(`${rid}.${exp}`).digest('hex');
function signedPath(rec) {
  const exp = Math.floor(Date.now() / 1000) + URL_TTL_S;
  return `/recordings/${rec._id}/stream?exp=${exp}&sig=${sign(String(rec._id), exp)}`;
}
function validSig(rid, exp, sig) {
  if (!/^\d+$/.test(String(exp)) || +exp < Date.now() / 1000 || typeof sig !== 'string') return false;
  const want = Buffer.from(sign(rid, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const publicRecording = (r) => r && ({
  id: r._id, status: r.status, kind: r.kind, mime: r.mime, offset_ms: r.offset_ms, chunks: r.chunks, bytes: r.bytes,
  duration_ms: r.duration_ms, started_at: r.started_at, ended_at: r.ended_at, size: r.storage?.size,
  retention: { policy: r.retention?.policy, bases: (r.retention?.bases ?? []).map((b) => ({ key: b, label: RETENTION_BASES[b] ?? b })) },
  consent: r.consent, error: r.error, deleted: r.deleted,
});

// Encerra a gravação: junta os pedaços e deixa o vídeo pronto. Chamado no /finish e quando a call acaba.
const finalizing = new Map();
export function finalizeRecording(callId, { clientDurationMs } = {}) {
  const key = String(callId);
  if (finalizing.has(key)) return finalizing.get(key);
  const job = (async () => {
    const rec = await Recording.findOneAndUpdate(
      { call_id: callId, status: 'recording' },
      { $set: { status: 'processing', ended_at: new Date(), ...(clientDurationMs ? { duration_ms: clientDurationMs } : {}) } },
      { returnDocument: 'after' },
    );
    if (!rec) return null;
    try {
      const out = await finalize(callId);
      rec.status = 'ready';
      rec.storage = { driver: 'disk', key: out.key, size: out.size };
      if (out.durationMs) rec.duration_ms = out.durationMs;
      await rec.save();
      await audit(rec, 'finalized', { details: { size: out.size, duration_ms: rec.duration_ms, remuxed: out.remuxed } });
    } catch (err) {
      rec.status = 'failed';
      rec.error = err.message;
      await rec.save();
      await audit(rec, 'failed', { reason: err.message });
    }
    return rec;
  })().finally(() => finalizing.delete(key));
  finalizing.set(key, job);
  return job;
}

export default async function recordingRoutes(app, { auth, loadOwnedCall }) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_CHUNK_BYTES },
    (req, body, done) => done(null, body));

  // Quem está logado (o CRM usa para mostrar ações de admin)
  app.get('/api/me', { preHandler: auth }, async (req) => ({ id: req.user._id, name: req.user.name, role: req.user.role }));

  // Início: exige o aviso de gravação confirmado pelo vendedor
  app.post('/calls/:id/recording/start', { preHandler: [auth, loadOwnedCall] }, async (req, reply) => {
    const { mime, kind = 'video', offset_ms = 0, consent } = req.body ?? {};
    if (req.call.status !== 'live') return reply.code(409).send({ error: 'A call não está ao vivo.' });
    if (!consent?.confirmed) return reply.code(400).send({ error: 'Confirme que os participantes foram avisados da gravação.' });
    const existing = await Recording.findOne({ call_id: req.call._id });
    if (existing) {
      if (existing.status !== 'recording') return reply.code(409).send({ error: 'Esta call já tem uma gravação encerrada.' });
      return { recording: publicRecording(existing), next_seq: existing.last_seq + 1 }; // retomada após recarregar
    }
    const rec = await Recording.create({
      call_id: req.call._id, org_id: req.call.org_id, seller_id: req.call.seller_id,
      kind: kind === 'audio' ? 'audio' : 'video',
      mime: typeof mime === 'string' ? mime.slice(0, 100) : 'video/webm',
      offset_ms: Number.isFinite(+offset_ms) ? Math.round(+offset_ms) : 0,
      consent: { confirmed: true, at: new Date(), by: req.user._id, text: String(consent.text || CONSENT_TEXT).slice(0, 1000) },
    });
    await audit(rec, 'created', { user: req.user, details: { bases: rec.retention.bases, consent_text: rec.consent.text } });
    return { recording: publicRecording(rec), next_seq: 0 };
  });

  // Pedaço do vídeo (corpo binário). Idempotente por seq.
  app.put('/calls/:id/recording/chunks/:seq', { preHandler: [auth, loadOwnedCall], bodyLimit: MAX_CHUNK_BYTES }, async (req, reply) => {
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq > 100000) return reply.code(400).send({ error: 'seq inválido' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).send({ error: 'Pedaço vazio' });
    const rec = await Recording.findOne({ call_id: req.call._id });
    if (!rec) return reply.code(404).send({ error: 'Gravação não iniciada.' });
    if (rec.status !== 'recording') return reply.code(409).send({ error: 'Gravação já encerrada.' });
    const resent = await writeChunk(req.call._id, seq, req.body);
    await Recording.updateOne({ _id: rec._id }, {
      $max: { last_seq: seq },
      ...(resent ? {} : { $inc: { chunks: 1, bytes: req.body.length } }),
    });
    return { ok: true, seq };
  });

  app.post('/calls/:id/recording/finish', { preHandler: [auth, loadOwnedCall] }, async (req) => {
    const d = Number(req.body?.duration_ms);
    void finalizeRecording(req.call._id, { clientDurationMs: Number.isFinite(d) && d > 0 ? Math.round(d) : undefined });
    return { ok: true, status: 'processing' };
  });

  // Ficha da gravação + link assinado para o player + trilha de auditoria
  app.get('/calls/:id/recording', { preHandler: [auth, loadOwnedCall] }, async (req) => {
    const rec = await Recording.findOne({ call_id: req.call._id });
    if (!rec) return { recording: null };
    let url = null;
    if (rec.status === 'ready') {
      url = signedPath(rec);
      // registra quem abriu o vídeo (no máximo 1 vez por hora por pessoa)
      const recent = await RecordingAudit.findOne({ recording_id: rec._id, user_id: req.user._id, action: 'viewed', at: { $gt: new Date(Date.now() - 3600e3) } }).lean();
      if (!recent) await audit(rec, 'viewed', { user: req.user });
    }
    const trail = await RecordingAudit.find({ recording_id: rec._id }).sort({ at: -1 }).limit(50).lean();
    return { recording: publicRecording(rec), url, audit: trail.map((a) => ({ action: a.action, at: a.at, user_name: a.user_name, reason: a.reason })) };
  });

  // Vídeo por faixas de bytes (Range). Autorizado pelo link assinado, porque a tag <video> não envia token.
  app.get('/recordings/:rid/stream', async (req, reply) => {
    const { rid } = req.params;
    if (!/^[a-f0-9]{24}$/i.test(rid) || !validSig(rid, req.query?.exp, req.query?.sig)) {
      return reply.code(403).send({ error: 'Link do vídeo inválido ou expirado. Reabra a call no CRM.' });
    }
    const rec = await Recording.findById(rid).lean();
    if (!rec || rec.status !== 'ready' || !rec.storage?.key) return reply.code(404).send({ error: 'Vídeo não disponível.' });
    const { file, size } = await fileInfo(rec.storage.key);
    const type = rec.mime?.startsWith('audio/') ? 'audio/webm' : 'video/webm';
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', type).header('Cache-Control', 'private, max-age=3600');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (!m) return reply.header('Content-Length', size).send(readRange(file, 0, size - 1));
    let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
    if (!(start >= 0 && start < size && end >= start)) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    end = Math.min(end, size - 1);
    return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1)
      .send(readRange(file, start, end));
  });

  // Pedido de exclusão feito por quem foi gravado: só admin decide, sempre com motivo registrado.
  // A guarda é permanente; excluir só com decisão explícita.
  app.post('/calls/:id/recording/deletion', { preHandler: [auth, loadOwnedCall] }, async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'Só administradores decidem pedidos de exclusão.' });
    const { decision, reason, requester } = req.body ?? {};
    const why = typeof reason === 'string' ? reason.trim() : '';
    if (!['delete', 'refuse'].includes(decision) || why.length < 10) {
      return reply.code(400).send({ error: 'Informe a decisão (excluir ou recusar) e o motivo (mínimo 10 caracteres).' });
    }
    const rec = await Recording.findOne({ call_id: req.call._id });
    if (!rec || rec.status === 'deleted') return reply.code(404).send({ error: 'Gravação não encontrada.' });
    const who = typeof requester === 'string' ? requester.trim().slice(0, 200) : '';
    await audit(rec, 'deletion_requested', { user: req.user, reason: who ? `Pedido de ${who}` : 'Pedido de exclusão registrado' });
    if (decision === 'refuse') {
      await audit(rec, 'deletion_refused', { user: req.user, reason: why });
      return { recording: publicRecording(rec) };
    }
    await removeRecording(req.call._id);
    rec.status = 'deleted';
    rec.deleted = { at: new Date(), by: req.user._id, reason: why };
    rec.storage = { driver: rec.storage?.driver, key: null, size: 0 };
    await rec.save();
    await audit(rec, 'deleted', { user: req.user, reason: why });
    return { recording: publicRecording(rec) };
  });
}

// Resumo leve para a lista do CRM
export async function recordingsByCall(callIds) {
  const list = await Recording.find({ call_id: { $in: callIds } }, { call_id: 1, status: 1, kind: 1, duration_ms: 1 }).lean();
  return new Map(list.map((r) => [String(r.call_id), { status: r.status, kind: r.kind, duration_ms: r.duration_ms }]));
}
