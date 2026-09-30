// Preenchimento automático dos dados da call (lead, empresa, cargo, título).
// Nunca sobrescreve um campo que o usuário editou à mão no CRM (call.manual_fields).
import { Call } from './models.js';

export const AUTOFILL_FIELDS = ['lead_name', 'lead_company', 'lead_role', 'meeting_title'];

// fields: { campo: valor }. onlyIfEmpty: campos que só são preenchidos se ainda estiverem vazios
// (ex.: nome vindo da IA não substitui o nome visto na lista de participantes).
export async function autofillCall(callId, fields, { onlyIfEmpty = [] } = {}) {
  const call = await Call.findById(callId, { manual_fields: 1, ...Object.fromEntries(AUTOFILL_FIELDS.map((f) => [f, 1])) }).lean();
  if (!call) return null;
  const manual = new Set(call.manual_fields ?? []);
  const set = {};
  for (const [k, raw] of Object.entries(fields)) {
    const v = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
    if (!AUTOFILL_FIELDS.includes(k) || !v || manual.has(k) || call[k] === v) continue;
    if (onlyIfEmpty.includes(k) && call[k]) continue;
    set[k] = v;
  }
  if (Object.keys(set).length) await Call.updateOne({ _id: callId }, { $set: set });
  return set;
}
