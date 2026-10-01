// Testa o módulo de gravação da extensão (extension/src/recorder.js) com um MediaRecorder simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../../extension/src/recorder.js', import.meta.url), 'utf8');

// Carrega o módulo com um MediaRecorder falso: tick() entrega um pedaço; stop() entrega o último e dispara 'stop'
function load() {
  const made = [];
  class FakeRecorder {
    static isTypeSupported(m) { return m.startsWith('video/webm;codecs=vp8'); }
    constructor(stream, opts) { this.mimeType = opts.mimeType; this.state = 'inactive'; this.listeners = {}; this.n = 0; made.push(this); }
    addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
    start() { this.state = 'recording'; this.onstart?.(); }
    tick() { this.ondataavailable?.({ data: { size: 10, id: this.n++ } }); }
    stop() { this.state = 'inactive'; this.tick(); for (const fn of this.listeners.stop ?? []) fn(); }
  }
  const ctx = { MediaRecorder: FakeRecorder, MediaStream: class {}, setTimeout, clearTimeout, Promise, Date, Math };
  ctx.self = ctx;
  vm.runInNewContext(src, ctx);
  return { api: ctx.CallTrackRecorder, made };
}

test('escolhe o formato de vídeo suportado pelo navegador', () => {
  assert.equal(load().api.pickMime('video'), 'video/webm;codecs=vp8,opus');
});

test('envia na ordem, reenvia o pedaço que falhou e só termina depois do último', async () => {
  const { api, made } = load();
  const sent = [];
  let failOnce = true;
  const r = api.createRecorder({
    stream: {}, startSeq: 3,
    upload: async (seq) => {
      if (seq === 4 && failOnce) { failOnce = false; throw new Error('rede'); }
      sent.push(seq);
    },
  });
  r.start();
  made[0].tick(); // pedaço 3
  made[0].tick(); // pedaço 4: falha uma vez e é reenviado
  const res = await r.stop(20_000); // pedaço 5 sai no stop
  assert.deepEqual(sent, [3, 4, 5]);
  assert.equal(res.pending, 0);
  assert.equal(res.dropped, 0);
});
