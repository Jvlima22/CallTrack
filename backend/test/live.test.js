import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyKnowledge, mergeKnowledge, computeHealth, sellerTalkPct } from '../src/liveLogic.js';

const byId = new Map([[1, { role: 'seller' }], [2, { role: 'lead' }], [3, { role: 'lead' }]]);

test('contexto por etapa: substitui contexto, acumula perguntas e citações pelo papel certo', () => {
  let k = emptyKnowledge();
  k = mergeKnowledge(k, { S: { context: '12 roteirizadores', question_turn_ids: [1, 2], quote_turn_ids: [2, 1] } }, byId);
  assert.deepEqual(k.S, { context: '12 roteirizadores', question_turn_ids: [1], quote_turn_ids: [2] });
  k = mergeKnowledge(k, { S: { context: '', quote_turn_ids: [3, 2] } }, byId);
  assert.equal(k.S.context, '12 roteirizadores');
  assert.deepEqual(k.S.quote_turn_ids, [2, 3]);
  assert.equal(k.P.context, '');
});

test('saúde da call', () => {
  const base = { now: 600_000, startedAt: 0, lastTurnAt: 590_000, lastProgressAt: 500_000, turnCount: 10, sellerTalkPct: 40 };
  assert.equal(computeHealth(base).level, 'good');
  assert.equal(computeHealth({ ...base, captionsFound: false }).level, 'idle');
  assert.equal(computeHealth({ ...base, lastTurnAt: 400_000 }).level, 'idle');
  assert.equal(computeHealth({ ...base, riskEvents: [{ type: 'overpromise', at: 550_000, note: 'x' }] }).level, 'risk');
  assert.equal(computeHealth({ ...base, riskEvents: [{ type: 'objection', at: 100_000 }] }).level, 'good'); // antiga
  assert.equal(computeHealth({ ...base, sellerTalkPct: 80 }).level, 'warn');
  assert.equal(computeHealth({ ...base, lastProgressAt: 100_000 }).level, 'warn');
});

test('% de fala do vendedor', () => {
  assert.equal(sellerTalkPct([{ role: 'seller', text: 'um dois três' }, { role: 'lead', text: 'quatro' }]), 75);
  assert.equal(sellerTalkPct([]), 0);
});
