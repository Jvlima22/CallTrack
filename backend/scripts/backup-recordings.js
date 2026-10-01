// Cópia de segurança das gravações (guardadas para sempre: perder o disco = perder as provas).
// Uso:  npm run backup:recordings -- "D:\Backup\CallTrack"
// Copia os vídeos novos ou alterados (incremental) e exporta as fichas e a auditoria em JSON.
import 'dotenv/config';
import { mkdir, readdir, stat, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { RECORDINGS_DIR } from '../src/storage.js';

const dest = process.argv[2];
if (!dest) {
  console.error('Uso: npm run backup:recordings -- <pasta de destino>');
  process.exit(1);
}
const target = path.resolve(dest);

async function copyTree(src, dst, stats) {
  await mkdir(dst, { recursive: true });
  let entries = [];
  try { entries = await readdir(src, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  for (const e of entries) {
    if (e.name === 'chunks' || e.name.endsWith('.tmp') || e.name.endsWith('.tmp.webm')) continue; // gravação em andamento
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) { await copyTree(from, to, stats); continue; }
    const a = await stat(from);
    const b = await stat(to).catch(() => null);
    if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) { stats.skipped += 1; continue; }
    await copyFile(from, to);
    stats.copied += 1;
    stats.bytes += a.size;
  }
}

const stats = { copied: 0, skipped: 0, bytes: 0 };
await copyTree(RECORDINGS_DIR, path.join(target, 'recordings'), stats);

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
const { Recording, RecordingAudit } = await import('../src/recordingModels.js');
const [recordings, auditTrail] = await Promise.all([Recording.find().lean(), RecordingAudit.find().lean()]);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
await writeFile(path.join(target, `metadata-${stamp}.json`), JSON.stringify({ exported_at: new Date(), recordings, audit: auditTrail }, null, 2));
await mongoose.disconnect();

console.log(`Backup em ${target}`);
console.log(`Vídeos copiados: ${stats.copied} (${(stats.bytes / 1e6).toFixed(1)} MB) · já estavam iguais: ${stats.skipped}`);
console.log(`Fichas: ${recordings.length} · registros de auditoria: ${auditTrail.length}`);
