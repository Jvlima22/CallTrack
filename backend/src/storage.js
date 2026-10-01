// Armazenamento dos arquivos de vídeo das calls (driver de disco).
// Estrutura: <RECORDINGS_DIR>/<callId>/chunks/000000.part ... -> <callId>/video.webm
// Trocar por nuvem (R2/S3) = implementar as mesmas funções em outro driver.
import { mkdir, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECORDINGS_DIR = path.resolve(
  process.env.RECORDINGS_DIR || fileURLToPath(new URL('../storage/recordings', import.meta.url)),
);
const FINAL_NAME = 'video.webm';
const safeId = (id) => {
  const s = String(id);
  if (!/^[a-f0-9]{24}$/i.test(s)) throw new Error('id de call inválido');
  return s;
};
const callDir = (callId) => path.join(RECORDINGS_DIR, safeId(callId));
const chunkPath = (callId, seq) => path.join(callDir(callId), 'chunks', `${String(seq).padStart(6, '0')}.part`);

// Grava um pedaço (idempotente: reenviar o mesmo seq sobrescreve com o mesmo conteúdo).
// Retorna true se o pedaço já existia (reenvio).
export async function writeChunk(callId, seq, buf) {
  const file = chunkPath(callId, seq);
  await mkdir(path.dirname(file), { recursive: true });
  const existed = await stat(file).then(() => true, () => false);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, file);
  return existed;
}

async function chunkFiles(callId) {
  try {
    return (await readdir(path.join(callDir(callId), 'chunks'))).filter((f) => f.endsWith('.part')).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function ffmpegPath() {
  try { return (await import('ffmpeg-static')).default; } catch { return null; }
}

function run(bin, args) {
  return new Promise((resolve) => {
    // timeout: um ffmpeg travado não pode segurar a finalização para sempre
    const child = execFile(bin, args, { maxBuffer: 20 * 1024 * 1024, timeout: 30 * 60 * 1000, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stderr: String(stderr) }));
    child.stdin?.end();
  });
}

// "time=00:01:02.34" (última ocorrência) ou "Duration: 00:01:02.34" -> ms
export function parseFfmpegDuration(stderr) {
  const toMs = (h, m, s) => Math.round(((+h * 60 + +m) * 60 + +s) * 1000);
  const times = [...String(stderr).matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (times.length) { const [, h, m, s] = times.at(-1); return toMs(h, m, s); }
  const d = String(stderr).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return d ? toMs(d[1], d[2], d[3]) : null;
}

// Junta os pedaços na ordem e remonta o arquivo com ffmpeg (sem recodificar) para o vídeo
// ganhar duração e índice de busca. Sem ffmpeg, fica o arquivo juntado (toca, mas sem avançar/voltar preciso).
export async function finalize(callId) {
  const dir = callDir(callId);
  const files = await chunkFiles(callId);
  if (!files.length) throw new Error('Nenhum pedaço de vídeo recebido');
  const raw = path.join(dir, 'raw.webm');
  await new Promise((resolve, reject) => {
    const out = createWriteStream(raw);
    out.on('error', reject);
    (async () => {
      for (const f of files) {
        await new Promise((res, rej) => {
          const inp = createReadStream(path.join(dir, 'chunks', f));
          inp.on('error', rej);
          inp.on('end', res);
          inp.pipe(out, { end: false });
        });
      }
      out.end(resolve);
    })().catch(reject);
  });

  const final = path.join(dir, FINAL_NAME);
  const bin = await ffmpegPath();
  let durationMs = null;
  let remuxed = false;
  if (bin) {
    const tmp = path.join(dir, 'video.tmp.webm');
    const { err, stderr } = await run(bin, ['-nostdin', '-y', '-hide_banner', '-fflags', '+genpts', '-i', raw, '-c', 'copy', tmp]);
    if (!err) {
      await rename(tmp, final);
      durationMs = parseFfmpegDuration(stderr);
      remuxed = true;
    } else {
      await rm(tmp, { force: true });
    }
  }
  if (!remuxed) await rename(raw, final);
  else await rm(raw, { force: true });
  // pedaços já estão dentro do arquivo final
  await rm(path.join(dir, 'chunks'), { recursive: true, force: true });
  const { size } = await stat(final);
  return { key: `${safeId(callId)}/${FINAL_NAME}`, size, durationMs, remuxed };
}

export async function fileInfo(key) {
  const file = path.join(RECORDINGS_DIR, key);
  if (!file.startsWith(RECORDINGS_DIR + path.sep)) throw new Error('caminho inválido');
  const { size } = await stat(file);
  return { file, size };
}

// Leitura por faixa de bytes (o player pede pedaços ao avançar/voltar).
export function readRange(file, start, end) {
  return createReadStream(file, { start, end });
}

export async function removeRecording(callId) {
  await rm(callDir(callId), { recursive: true, force: true });
}

// Soma do que já chegou (para conferir tamanho)
export async function chunksSize(callId) {
  let total = 0;
  for (const f of await chunkFiles(callId)) total += (await stat(path.join(callDir(callId), 'chunks', f))).size;
  return total;
}

