// Conexão com MongoDB Atlas e helpers que substituem o cliente Supabase.
// A interface pública (defaultPlaybook, must-equivalente) é mantida
// para que server.js, live.js e analyze.js mudem o mínimo possível.

import mongoose from 'mongoose';
import { Playbook } from './models.js';

export { mongoose };

export async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI não definida no .env');
  await mongoose.connect(uri, {
    // Recomendado para Atlas: serverless e replica set
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 45_000,
  });
  console.log('[db] MongoDB conectado:', mongoose.connection.host);
}

export async function defaultPlaybook(orgId) {
  return Playbook.findOne({ org_id: orgId, is_default: true })
    .sort({ version: -1 })
    .lean();
}
