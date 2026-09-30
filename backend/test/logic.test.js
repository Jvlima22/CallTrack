import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, computeScore } from '../src/metrics.js';
import { mergeStages, shouldEvaluate, laggingStage } from '../src/liveLogic.js';
import { DEFAULT_SPICED, emptyStages } from '../src/playbook.js';

const turns = [
  { seq: 0, role: 'seller', text: 'Como funciona hoje o processo?', started_ms: 0, ended_ms: 3000 },
  { seq: 1, role: 'lead', text: 'Usamos planilha e doze SDRs fazem tudo na mão', started_ms: 3500, ended_ms: 9000 },
  { seq: 2, role: 'lead', text: 'e isso custa uns trinta mil por mês', started_ms: 9000, ended_ms: 70000 },
  { seq: 3, role: 'seller', text: 'Entendi. Quem mais decide?', started_ms: 70500, ended_ms: 73000 },
];

test('métricas de fala', () => {
  const m = computeMetrics(turns);
  assert.equal(m.turn_count, 2);
  assert.equal(m.question_count, 2);
  assert.equal(m.longest_lead_monologue_s, 67);
  assert.equal(m.duration_s, 73);
  assert.ok(m.seller_talk_pct > 20 && m.seller_talk_pct < 40);
});

test('nota: completo=1, parcial=0.5, penalidade por fala fora da faixa', () => {
  const st = emptyStages();
  st.S.status = 'complete'; st.P.status = 'complete'; st.I.status = 'partial';
  const m = computeMetrics(turns);
  assert.equal(computeScore(st, DEFAULT_SPICED, m, []), 4.5); // 5 - 0.5
  assert.equal(computeScore(st, DEFAULT_SPICED, m, [{ type: 'overpromise' }]), 3.5);
});

test('monotonicidade: verde não volta', () => {
  const cur = emptyStages();
  cur.S = { status: 'complete', reason: 'ok', evidence_turn_ids: [1] };
  const { stages, changes } = mergeStages(cur, {
    S: { status: 'partial', reason: 'x' },
    P: { status: 'partial', reason: 'sintoma', evidence_turn_ids: [2] },
  });
  assert.equal(stages.S.status, 'complete');
  assert.equal(stages.P.status, 'partial');
  assert.deepEqual(changes, [{ stage: 'P', from: 'none', to: 'partial' }]);
});

test('gatilho: fala do lead dispara, só vendedor espera 30 s', () => {
  assert.equal(shouldEvaluate({ newTurns: [{ role: 'lead' }], lastEvalAt: 0, now: 6000 }), true);
  assert.equal(shouldEvaluate({ newTurns: [{ role: 'seller' }], lastEvalAt: 0, now: 6000 }), false);
  assert.equal(shouldEvaluate({ newTurns: [{ role: 'seller' }], lastEvalAt: 0, now: 31000 }), true);
  assert.equal(shouldEvaluate({ newTurns: [{ role: 'lead' }], lastEvalAt: 0, now: 2000 }), false);
});

test('etapa mais atrasada', () => {
  const st = emptyStages();
  st.S.status = 'complete';
  assert.equal(laggingStage(st), 'P');
});
