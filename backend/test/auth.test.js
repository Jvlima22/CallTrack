import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, passwordProblem, parseCookies, sessionCookie, clearSessionCookie, sameOrigin,
  AttemptLimiter, sessionAlive, normalizeEmail, validEmail, hashSecret, newSecret, SESSION_IDLE_MS,
} from '../src/authLogic.js';

test('senha: hash confere só com a senha certa e usa sal novo a cada vez', async () => {
  const h1 = await hashPassword('correta-cavalo-bateria');
  const h2 = await hashPassword('correta-cavalo-bateria');
  assert.match(h1, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(h1, h2);
  assert.equal(await verifyPassword('correta-cavalo-bateria', h1), true);
  assert.equal(await verifyPassword('correta-cavalo-bateriA', h1), false);
  assert.equal(await verifyPassword('qualquer', ''), false);
  assert.equal(await verifyPassword('qualquer', 'md5$abc'), false);
});

test('senha: regras mínimas', () => {
  assert.match(passwordProblem('curta'), /10 caracteres/);
  assert.match(passwordProblem('aaaaaaaaaaaa'), /fácil/);
  assert.match(passwordProblem('1234567890abc'), /fácil/);
  assert.match(passwordProblem('josulima90-2026', { email: 'josulima90@gmail.com' }), /e-mail/);
  assert.equal(passwordProblem('Pôr-do-sol na praia 7'), null);
  assert.match(passwordProblem(undefined), /10 caracteres/);
});

test('cookie de sessão: HttpOnly, SameSite=Lax e Secure só em https', () => {
  const c = sessionCookie('abc', { secure: true });
  for (const part of ['ct_session=abc', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Secure', 'Max-Age=2592000']) assert.ok(c.includes(part), part);
  assert.ok(!sessionCookie('abc', { secure: false }).includes('Secure'));
  assert.ok(clearSessionCookie({ secure: false }).includes('Max-Age=0'));
  assert.deepEqual(parseCookies('a=1; ct_session=x%2By; ruim; b=2=3'), { a: '1', ct_session: 'x+y', b: '2=3' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('origem: leitura passa; escrita só com Origin do mesmo host', () => {
  const h = (extra) => ({ host: 'crm.exemplo.com', ...extra });
  assert.equal(sameOrigin({ method: 'GET', headers: h() }), true);
  assert.equal(sameOrigin({ method: 'POST', headers: h({ origin: 'https://crm.exemplo.com' }) }), true);
  assert.equal(sameOrigin({ method: 'POST', headers: h({ origin: 'https://malicioso.com' }) }), false);
  assert.equal(sameOrigin({ method: 'PATCH', headers: h() }), false);
  assert.equal(sameOrigin({ method: 'DELETE', headers: h({ origin: 'null' }) }), false);
  // atrás do túnel: Host local, página no endereço público
  const tun = { method: 'POST', headers: { host: 'localhost:8787', origin: 'https://abc.trycloudflare.com' } };
  assert.equal(sameOrigin(tun), false);
  assert.equal(sameOrigin(tun, ['localhost:8787', 'abc.trycloudflare.com']), true);
  assert.equal(sameOrigin(tun, ['localhost:8787', undefined]), false);
});

test('limite de tentativas: bloqueia na 5ª falha e libera depois da janela', () => {
  let t = 0;
  const lim = new AttemptLimiter({ max: 5, windowMs: 1000, now: () => t });
  for (let i = 0; i < 4; i++) lim.fail('k');
  assert.equal(lim.blocked('k'), false);
  lim.fail('k');
  assert.equal(lim.blocked('k'), true);
  assert.equal(lim.retryAfterS('k'), 1);
  t = 1001;
  assert.equal(lim.blocked('k'), false);
  lim.fail('k'); lim.reset('k');
  assert.equal(lim.blocked('k'), false);
});

test('sessão: expira por idade, por inatividade e quando revogada', () => {
  const now = Date.now();
  const s = { created_at: new Date(now - 1000), last_seen_at: new Date(now - 1000), expires_at: new Date(now + 1e6) };
  assert.equal(sessionAlive(s, now), true);
  assert.equal(sessionAlive({ ...s, revoked_at: new Date() }, now), false);
  assert.equal(sessionAlive({ ...s, expires_at: new Date(now - 1) }, now), false);
  assert.equal(sessionAlive({ ...s, last_seen_at: new Date(now - SESSION_IDLE_MS - 1) }, now), false);
  assert.equal(sessionAlive(null, now), false);
});

test('e-mail e segredos', () => {
  assert.equal(normalizeEmail('  Fulano@Empresa.COM '), 'fulano@empresa.com');
  assert.equal(validEmail('a@b.co'), true);
  assert.equal(validEmail('sem-arroba'), false);
  const s = newSecret('spc_');
  assert.match(s, /^spc_[A-Za-z0-9_-]{43}$/);
  assert.equal(hashSecret(s), hashSecret(s));
  assert.equal(hashSecret(s).length, 64);
});
