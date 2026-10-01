// Regras de autenticação sem banco (testáveis isoladamente): senha, cookie de sessão,
// limite de tentativas e verificação de origem.
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'ct_session';
export const SESSION_MAX_MS = 30 * 24 * 3600e3;   // idade máxima da sessão
export const SESSION_IDLE_MS = 7 * 24 * 3600e3;   // sem uso por 7 dias, a sessão cai
export const PASSWORD_LINK_MS = 7 * 24 * 3600e3;  // validade do link de definir senha
export const MIN_PASSWORD = 10;

// scrypt (nativo do Node): custo alto o bastante para atrasar ataque offline sem pesar no login
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const scryptAsync = (pw, salt, { N, r, p, keylen }) => new Promise((resolve, reject) =>
  crypto.scrypt(pw, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password).normalize('NFKC'), salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  const got = await scryptAsync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'),
    { N: +N, r: +r, p: +p, keylen: want.length });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// Hash usado quando o e-mail não existe: o login leva o mesmo tempo e não revela quem tem conta
let dummyHash = null;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword(crypto.randomBytes(12).toString('hex'));
  await verifyPassword(password, dummyHash);
  return false;
}

export function passwordProblem(password, { email = '', name = '' } = {}) {
  const pw = typeof password === 'string' ? password : '';
  if (pw.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (pw.length > 200) return 'A senha pode ter no máximo 200 caracteres.';
  const low = pw.toLowerCase();
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && low.includes(local)) return 'A senha não pode conter o seu e-mail.';
  if (/^(.)\1+$/.test(pw) || /^(?:0123456789|1234567890|abcdefghij|qwertyuiop)/.test(low)) return 'Essa senha é fácil demais de adivinhar.';
  if (name && low === String(name).toLowerCase().replace(/\s+/g, '')) return 'A senha não pode ser o seu nome.';
  return null;
}

export const normalizeEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

// Segredos aleatórios (sessão, token da extensão, link de senha); no banco só fica o sha256
export const newSecret = (prefix = '') => prefix + crypto.randomBytes(32).toString('base64url');
export const hashSecret = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
    }
  }
  return out;
}

export function sessionCookie(value, { secure, maxAgeMs = SESSION_MAX_MS }) {
  return [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ['Secure'] : [])].join('; ');
}
export const clearSessionCookie = ({ secure }) => sessionCookie('', { secure, maxAgeMs: 0 });

// Contra CSRF: ações que mudam dados, autenticadas por cookie, só valem se vierem da própria página.
// SameSite=Lax já barra a maioria; isto cobre navegadores antigos e subdomínios.
// hosts: endereços aceitos para a própria página (o Host e, atrás do túnel local, o X-Forwarded-Host).
export function sameOrigin({ method, headers }, hosts = [headers.host]) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
  const origin = headers.origin;
  if (!origin) return false;
  try { const h = new URL(origin).host; return hosts.some((x) => x && x === h); } catch { return false; }
}

// Limite de tentativas em memória (zera ao reiniciar o servidor): por e-mail e por IP
export class AttemptLimiter {
  constructor({ max, windowMs, now = () => Date.now() }) { Object.assign(this, { max, windowMs, now, hits: new Map() }); }
  #fresh(key) {
    const t = this.now(), list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (list.length) this.hits.set(key, list); else this.hits.delete(key);
    return list;
  }
  blocked(key) { return this.#fresh(key).length >= this.max; }
  retryAfterS(key) {
    const list = this.#fresh(key);
    return list.length < this.max ? 0 : Math.ceil((list[0] + this.windowMs - this.now()) / 1000);
  }
  fail(key) { const list = this.#fresh(key); list.push(this.now()); this.hits.set(key, list); }
  reset(key) { this.hits.delete(key); }
}

// Sessão ainda vale? (expiração absoluta e por inatividade)
export function sessionAlive(s, now = Date.now()) {
  if (!s || s.revoked_at) return false;
  if (new Date(s.expires_at).getTime() <= now) return false;
  return now - new Date(s.last_seen_at || s.created_at).getTime() < SESSION_IDLE_MS;
}
