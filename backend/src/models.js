// Modelos Mongoose do CallTrack.
// Substitui as tabelas do Supabase. Cada documento reflete a mesma estrutura
// de campos para que o resto do código (server.js, live.js, analyze.js) mude o mínimo.

import mongoose from 'mongoose';
const { Schema, model, Types } = mongoose;

// ─── Org ────────────────────────────────────────────────────────────────────
const orgSchema = new Schema({
  name:         { type: String, required: true, unique: true },
  email_domain: String,
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });
export const Org = model('Org', orgSchema);

// ─── Team ───────────────────────────────────────────────────────────────────
const teamSchema = new Schema({
  org_id:     { type: Types.ObjectId, ref: 'Org', required: true },
  name:       { type: String, required: true },
  manager_id: { type: Types.ObjectId, ref: 'User' },
});
export const Team = model('Team', teamSchema);

// ─── User ───────────────────────────────────────────────────────────────────
const userSchema = new Schema({
  org_id:          { type: Types.ObjectId, ref: 'Org', required: true },
  team_id:         { type: Types.ObjectId, ref: 'Team' },
  role:            { type: String, enum: ['seller', 'manager', 'admin'], required: true },
  name:            { type: String, required: true },
  email:           { type: String, required: true, unique: true },
  api_token_hash:  { type: String, unique: true, sparse: true },
});
export const User = model('User', userSchema);

// ─── Playbook ────────────────────────────────────────────────────────────────
const playbookSchema = new Schema({
  org_id:     { type: Types.ObjectId, ref: 'Org', required: true },
  name:       { type: String, required: true },
  product:    String,
  version:    { type: Number, required: true },
  definition: { type: Schema.Types.Mixed, required: true },
  is_default: { type: Boolean, default: false },
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });
playbookSchema.index({ org_id: 1, name: 1, version: 1 }, { unique: true });
export const Playbook = model('Playbook', playbookSchema);

// ─── Call ────────────────────────────────────────────────────────────────────
const callSchema = new Schema({
  org_id:       { type: Types.ObjectId, ref: 'Org', required: true },
  seller_id:    { type: Types.ObjectId, ref: 'User', required: true },
  playbook_id:  { type: Types.ObjectId, ref: 'Playbook', required: true },
  platform:     { type: String, default: 'meet' },
  meeting_code: String,
  lead_name:    String,
  lead_company: String,
  lead_role:    String,          // cargo do lead (extraído da conversa)
  meeting_title: String,         // título da reunião no Meet/Agenda
  crm_deal_id:  String,
  // Pessoas que apareceram na reunião (lista de participantes do Meet + falantes das legendas).
  // O Meet não expõe e-mail/telefone dos outros participantes na página.
  participants: [{
    _id: false,
    name:          String,
    avatar_url:    String,
    is_self:       Boolean,
    role:          { type: String, enum: ['seller', 'lead', 'internal'] },
    first_seen_at: Date,
    last_seen_at:  Date,
    left_at:       Date,
    talk_ms:       { type: Number, default: 0 },
    turn_count:    { type: Number, default: 0 },
  }],
  // Campos editados à mão no CRM: o preenchimento automático não sobrescreve.
  manual_fields: [String],
  last_activity_at: Date,
  started_at:   { type: Date, default: Date.now },
  ended_at:     Date,
  status:       { type: String, enum: ['live', 'processing', 'done', 'failed'], default: 'live' },
  outcome:      { type: String, enum: ['won', 'lost', 'open'], default: 'open' },
});
callSchema.index({ org_id: 1, started_at: -1 });
callSchema.index({ seller_id: 1, started_at: -1 });
export const Call = model('Call', callSchema);

// ─── Turn ─────────────────────────────────────────────────────────────────────
const turnSchema = new Schema({
  call_id:      { type: Types.ObjectId, ref: 'Call', required: true },
  seq:          { type: Number, required: true },
  speaker_name: String,
  role:         { type: String, enum: ['seller', 'lead', 'internal'], required: true },
  text:         { type: String, required: true },
  started_ms:   { type: Number, required: true },
  ended_ms:     { type: Number, required: true },
});
turnSchema.index({ call_id: 1, seq: 1 }, { unique: true });
export const Turn = model('Turn', turnSchema);

// ─── LiveState ───────────────────────────────────────────────────────────────
const liveStateSchema = new Schema({
  call_id:         { type: Types.ObjectId, ref: 'Call', required: true, unique: true },
  stages:          Schema.Types.Mixed,
  rolling_summary: String,
  knowledge:       Schema.Types.Mixed,  // por etapa: contexto, perguntas e citações ao vivo
  health:          Schema.Types.Mixed,  // { level, reason, at }
  updated_at:      { type: Date, default: Date.now },
});
export const LiveState = model('LiveState', liveStateSchema);

// ─── LiveEvent ───────────────────────────────────────────────────────────────
const liveEventSchema = new Schema({
  call_id: { type: Types.ObjectId, ref: 'Call', required: true },
  at_ms:   { type: Number, required: true },
  type:    { type: String, enum: ['stage_change', 'suggestion', 'objection', 'case_request', 'overpromise'], required: true },
  payload: Schema.Types.Mixed,
});
liveEventSchema.index({ call_id: 1, at_ms: 1 });
export const LiveEvent = model('LiveEvent', liveEventSchema);

// ─── CallAnalysis ─────────────────────────────────────────────────────────────
const callAnalysisSchema = new Schema({
  call_id:               { type: Types.ObjectId, ref: 'Call', required: true, unique: true },
  playbook_version:      Number,
  model:                 String,
  score:                 Number,
  stages:                Schema.Types.Mixed,
  seller_talk_pct:       Number,
  longest_monologue_s:   Number,
  turn_count:            Number,
  question_count:        Number,
  objections:            [Schema.Types.Mixed],
  risk_signals:          [Schema.Types.Mixed],
  summary:               Schema.Types.Mixed,
  next_steps:            [Schema.Types.Mixed],
  is_critical:           { type: Boolean, default: false },
  cost_usd:              Number,
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });
export const CallAnalysis = model('CallAnalysis', callAnalysisSchema);

// ─── KnowledgeItem ───────────────────────────────────────────────────────────
const knowledgeItemSchema = new Schema({
  org_id:    { type: Types.ObjectId, ref: 'Org', required: true },
  kind:      { type: String, enum: ['case', 'objection', 'pricing', 'faq'], required: true },
  title:     { type: String, required: true },
  body:      { type: String, required: true },
  tags:      [String],
  embedding: [Number],   // vector 1536 armazenado como array
});
knowledgeItemSchema.index({ org_id: 1, kind: 1 });
export const KnowledgeItem = model('KnowledgeItem', knowledgeItemSchema);
