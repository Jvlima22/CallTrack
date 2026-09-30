import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(__dirname, '../../extension/src/captions.js'), 'utf8');
const context = { self: {} };
runInNewContext(code, context);
const { CaptionTracker, roleFor } = context.self.CallTrackCaptions;

function setup() {
  let clock = 0;
  const out = [];
  const tr = new CaptionTracker({ onCommit: (t) => out.push(t), now: () => clock, startedAt: 0 });
  return { tr, out, advance: (ms) => (clock += ms) };
}

test('texto crescendo não gera fala até estabilizar', () => {
  const { tr, out, advance } = setup();
  const a = {};
  tr.update([{ key: a, speaker: 'Maria', text: 'Hoje a gente' }]);
  advance(500);
  tr.update([{ key: a, speaker: 'Maria', text: 'Hoje a gente usa planilha' }]);
  assert.equal(out.length, 0);
  advance(1600);
  tr.tick();
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Hoje a gente usa planilha');
});

test('troca de falante confirma o bloco anterior na hora', () => {
  const { tr, out, advance } = setup();
  const a = {}, b = {};
  tr.update([{ key: a, speaker: 'Você', text: 'Como funciona hoje?' }]);
  advance(300);
  tr.update([{ key: a, speaker: 'Você', text: 'Como funciona hoje?' }, { key: b, speaker: 'Maria', text: 'Então' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].speaker_name, 'Você');
});

test('bloco que continua crescendo depois de confirmado vira nova fala, sem repetir texto', () => {
  const { tr, out, advance } = setup();
  const a = {};
  tr.update([{ key: a, speaker: 'Maria', text: 'Temos doze SDRs.' }]);
  advance(1600); tr.tick();
  advance(1000);
  tr.update([{ key: a, speaker: 'Maria', text: 'Temos doze SDRs. E a meta é dobrar.' }]);
  advance(1600); tr.tick();
  assert.deepEqual(out.map((t) => t.text), ['Temos doze SDRs.', 'E a meta é dobrar.']);
  assert.equal(out[1].seq, 1);
  assert.ok(out[1].started_ms > out[0].ended_ms);
});

test('correção do Meet que encurta o texto não duplica nem quebra', () => {
  const { tr, out, advance } = setup();
  const a = {};
  tr.update([{ key: a, speaker: 'Maria', text: 'Custa trinta mil por mês' }]);
  advance(1600); tr.tick();
  tr.update([{ key: a, speaker: 'Maria', text: 'Custa trinta mil' }]);
  advance(1600); tr.tick();
  assert.equal(out.length, 1);
});

test('papel pelo rótulo do falante', () => {
  assert.equal(roleFor('Você', ['Você', 'You']), 'seller');
  assert.equal(roleFor('Maria Souza', ['Você', 'You']), 'lead');
});
