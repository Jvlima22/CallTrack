// Ficha dos vídeos das calls e trilha de auditoria.
// Os arquivos de vídeo NÃO ficam no banco: ficam no armazenamento de gravações (storage.js).
// Por padrão usa o mesmo MongoDB do CRM; com RECORDINGS_MONGODB_URI no .env, vai para um banco separado.
import mongoose from 'mongoose';
const { Schema, Types } = mongoose;

const conn = process.env.RECORDINGS_MONGODB_URI
  ? mongoose.createConnection(process.env.RECORDINGS_MONGODB_URI, { serverSelectionTimeoutMS: 10_000 })
  : mongoose.connection;

// Motivos que justificam guardar a gravação para sempre (LGPD).
export const RETENTION_BASES = {
  prova_negociacao: 'Prova de negociação ou de contrato, para exercício regular de direitos em eventual disputa',
  obrigacao_legal: 'Cumprimento de obrigação legal ou regulatória',
};

const recordingSchema = new Schema({
  call_id:    { type: Types.ObjectId, required: true, unique: true },
  org_id:     { type: Types.ObjectId, required: true },
  seller_id:  { type: Types.ObjectId, required: true },
  status:     { type: String, enum: ['recording', 'processing', 'ready', 'failed', 'deleted'], default: 'recording' },
  kind:       { type: String, enum: ['video', 'audio'], default: 'video' },
  mime:       String,
  // ms entre o início da captura das legendas e o início do vídeo (sincroniza falas e vídeo)
  offset_ms:  { type: Number, default: 0 },
  chunks:     { type: Number, default: 0 },   // pedaços recebidos
  last_seq:   { type: Number, default: -1 },
  bytes:      { type: Number, default: 0 },
  duration_ms: Number,
  started_at: { type: Date, default: Date.now },
  ended_at:   Date,
  storage:    { driver: { type: String, default: 'disk' }, key: String, size: Number },
  retention:  {
    policy: { type: String, default: 'forever' },
    bases:  { type: [String], default: () => Object.keys(RETENTION_BASES) },
  },
  consent: {
    confirmed: { type: Boolean, default: false },
    at:        Date,
    by:        Types.ObjectId,
    text:      String,
  },
  error:      String,
  deleted:    { at: Date, by: Types.ObjectId, reason: String },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });
recordingSchema.index({ org_id: 1, created_at: -1 });

const auditSchema = new Schema({
  recording_id: { type: Types.ObjectId, required: true },
  call_id:      { type: Types.ObjectId, required: true },
  org_id:       { type: Types.ObjectId, required: true },
  user_id:      Types.ObjectId,
  user_name:    String,
  action: {
    type: String,
    enum: ['created', 'finalized', 'failed', 'viewed', 'deletion_requested', 'deleted', 'deletion_refused'],
    required: true,
  },
  reason:  String,
  details: Schema.Types.Mixed,
  at:      { type: Date, default: Date.now },
}, { collection: 'recording_audit' });
auditSchema.index({ recording_id: 1, at: -1 });

export const Recording = conn.model('Recording', recordingSchema);
export const RecordingAudit = conn.model('RecordingAudit', auditSchema);

export async function audit(rec, action, { user, reason, details } = {}) {
  await RecordingAudit.create({
    recording_id: rec._id, call_id: rec.call_id, org_id: rec.org_id,
    user_id: user?._id, user_name: user?.name, action, reason, details,
  });
}
