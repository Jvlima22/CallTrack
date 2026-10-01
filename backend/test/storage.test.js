import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Diretório temporário antes de importar o módulo (ele lê RECORDINGS_DIR ao carregar)
const dir = await mkdtemp(path.join(os.tmpdir(), 'ct-rec-'));
process.env.RECORDINGS_DIR = dir;
const { writeChunk, finalize, parseFfmpegDuration, fileInfo, removeRecording } = await import('../src/storage.js');

const CALL = 'aaaaaaaaaaaaaaaaaaaaaaaa';

test('duração lida da saída do ffmpeg', () => {
  assert.equal(parseFfmpegDuration('... time=00:00:10.50 ... time=00:01:02.34 bitrate'), 62340);
  assert.equal(parseFfmpegDuration('Duration: 01:00:00.00, start'), 3600000);
  assert.equal(parseFfmpegDuration('nada'), null);
});

test('pedaços fora de ordem e reenviados viram um arquivo na ordem certa', async () => {
  assert.equal(await writeChunk(CALL, 2, Buffer.from('CC')), false);
  assert.equal(await writeChunk(CALL, 0, Buffer.from('AA')), false);
  assert.equal(await writeChunk(CALL, 1, Buffer.from('BB')), false);
  assert.equal(await writeChunk(CALL, 1, Buffer.from('BB')), true); // reenvio
  const out = await finalize(CALL); // não é vídeo de verdade: ffmpeg falha e fica o arquivo juntado
  assert.equal(out.remuxed, false);
  const { file, size } = await fileInfo(out.key);
  assert.equal(size, 6);
  assert.equal(await readFile(file, 'utf8'), 'AABBCC');
  await assert.rejects(stat(path.join(dir, CALL, 'chunks')));
  await removeRecording(CALL);
  await assert.rejects(stat(path.join(dir, CALL)));
});

test('id de call inválido não vira caminho no disco', async () => {
  await assert.rejects(writeChunk('../../etc', 0, Buffer.from('x')), /inválido/);
  await assert.rejects(fileInfo('../fora.webm'), /inválido/);
});

test.after(() => rm(dir, { recursive: true, force: true }));
