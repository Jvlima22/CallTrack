// Provedor de IA: escolha pelo .env e chamada ao Gemini (com fetch simulado, sem rede).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.LLM_PROVIDER;
delete process.env.ANTHROPIC_API_KEY;
process.env.GEMINI_API_KEY = 'chave-teste';
process.env.GEMINI_LIVE_MODEL = 'gemini-teste-live';
const { callModel, llmProvider } = await import('../src/llm.js');

let lastReq;
function fakeFetch(status, body) {
  globalThis.fetch = async (url, init) => {
    lastReq = { url, init, body: JSON.parse(init.body) };
    return { ok: status < 400, status, json: async () => body };
  };
}

beforeEach(() => { delete process.env.LLM_PROVIDER; process.env.GEMINI_API_KEY = 'chave-teste'; delete process.env.ANTHROPIC_API_KEY; });

test('escolhe o provedor pelo .env', () => {
  assert.equal(llmProvider(), 'gemini');            // só a chave do Gemini preenchida
  process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
  assert.equal(llmProvider(), 'anthropic');         // com as duas, o Claude é o padrão
  process.env.LLM_PROVIDER = 'gemini';
  assert.equal(llmProvider(), 'gemini');            // escolha explícita vence
});

test('Gemini: monta o pedido e lê a resposta em JSON', async () => {
  fakeFetch(200, {
    modelVersion: 'gemini-teste-live-001',
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'pensando…', thought: true }, { text: '{"stages":{"S":{"status":"partial"}}}' }] } }],
    usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 20 },
  });
  const r = await callModel({ kind: 'live', model: 'claude-haiku-4-5', system: 'regras', user: 'falas', maxTokens: 600 });
  assert.match(lastReq.url, /models\/gemini-teste-live:generateContent$/);
  assert.equal(lastReq.init.headers['x-goog-api-key'], 'chave-teste');
  assert.equal(lastReq.body.systemInstruction.parts[0].text, 'regras');
  assert.equal(lastReq.body.contents[0].parts[0].text, 'falas');
  assert.equal(lastReq.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(lastReq.body.generationConfig.maxOutputTokens >= 2400);
  assert.deepEqual(r.data, { stages: { S: { status: 'partial' } } }); // ignora a parte "pensando"
  assert.equal(r.model, 'gemini-teste-live-001');
  assert.equal(r.costUsd, 0);                                          // nível gratuito
  assert.equal(r.usage.output_tokens, 70);
});

test('Gemini: texto livre (resumo) sem forçar JSON', async () => {
  fakeFetch(200, { candidates: [{ content: { parts: [{ text: '  Resumo da call.  ' }] } }] });
  const r = await callModel({ kind: 'live', system: 's', user: 'u', json: false });
  assert.equal(r.data, 'Resumo da call.');
  assert.equal(lastReq.body.generationConfig.responseMimeType, undefined);
});

test('Gemini: erros com mensagem clara', async () => {
  fakeFetch(429, { error: { message: 'Resource exhausted' } });
  await assert.rejects(callModel({ kind: 'live', system: 's', user: 'u' }), /limite do nível gratuito/);
  fakeFetch(404, { error: { message: 'not found' } });
  await assert.rejects(callModel({ kind: 'postcall', system: 's', user: 'u' }), /GEMINI_POSTCALL_MODEL/);
  fakeFetch(200, { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] });
  await assert.rejects(callModel({ kind: 'live', system: 's', user: 'u' }), /resposta vazia \(SAFETY\)/);
  delete process.env.GEMINI_API_KEY;
  process.env.LLM_PROVIDER = 'gemini';
  await assert.rejects(callModel({ kind: 'live', system: 's', user: 'u' }), /GEMINI_API_KEY não definida/);
});

test('Gemini: sobrecarga no pós-call tenta de novo e cai para o modelo do ao vivo', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (!url.includes('gemini-teste-live')) return { ok: false, status: 503, json: async () => ({ error: { message: 'high demand' } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }) };
  };
  const r = await callModel({ kind: 'postcall', system: 's', user: 'u' });
  assert.deepEqual(r.data, { ok: true });
  assert.equal(urls.filter((u) => /gemini-flash-latest/.test(u)).length, 3); // 1 tentativa + 2 novas
  assert.match(urls.at(-1), /gemini-teste-live/);
});
