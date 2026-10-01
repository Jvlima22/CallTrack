// Login do CRM (e-mail + senha, sessão em cookie), tokens da extensão por computador
// e administração de usuários. As regras puras ficam em authLogic.js.
import { User, Team, Org, Session, ApiToken, PasswordLink, AuthEvent } from './models.js';
import {
  SESSION_COOKIE, SESSION_MAX_MS, PASSWORD_LINK_MS, hashPassword, verifyPassword, burnPasswordCheck, passwordProblem,
  normalizeEmail, validEmail, newSecret, hashSecret, parseCookies, sessionCookie, clearSessionCookie, sameOrigin,
  AttemptLimiter, sessionAlive,
} from './authLogic.js';

const ROLES = ['seller', 'manager', 'admin'];
const TOUCH_MS = 5 * 60e3;          // grava "último uso" no máximo a cada 5 min
const MAX_TOKENS_PER_USER = 20;
const byEmail = new AttemptLimiter({ max: 5, windowMs: 15 * 60e3 });
const byIp = new AttemptLimiter({ max: 30, windowMs: 15 * 60e3 });
const active = { active: { $ne: false } }; // usuários antigos não têm o campo

const isHttps = (req) => req.protocol === 'https';
const clientInfo = (req) => ({ ip: req.ip, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) });
// req.host segue o X-Forwarded-Host só quando a requisição vem do proxy confiável (trustProxy)
const originOk = (req) => sameOrigin(req, [req.headers.host, req.host]);
const idOk = (id) => /^[a-f0-9]{24}$/i.test(String(id));

export async function logAuth(req, { user, actor, email, action, ok = true, detail }) {
  await AuthEvent.create({
    org_id: user?.org_id ?? actor?.org_id, user_id: user?._id, actor_id: actor?._id,
    email: email ?? user?.email, action, ok, detail, ...(req ? clientInfo(req) : {}),
  }).catch(() => {});
}

// Link de uso único para definir a senha. Invalida os links anteriores da pessoa.
export async function createPasswordLink(user, { createdBy } = {}) {
  await PasswordLink.updateMany({ user_id: user._id, used_at: null }, { $set: { used_at: new Date() } });
  const token = newSecret();
  const expires_at = new Date(Date.now() + PASSWORD_LINK_MS);
  await PasswordLink.create({
    user_id: user._id, token_hash: hashSecret(token), purpose: user.password_hash ? 'reset' : 'invite',
    created_by: createdBy?._id, expires_at,
  });
  return { path: `/#senha=${token}`, expires_at };
}

// Tokens do seed (um por usuário, no próprio usuário) viram tokens por computador, sem trocar o valor:
// a extensão já configurada continua funcionando e o token aparece (e pode ser revogado) no CRM.
export async function migrateLegacyTokens() {
  const users = await User.find({ api_token_hash: { $exists: true, $ne: null } }, { api_token_hash: 1 }).lean();
  for (const u of users) {
    await ApiToken.updateOne({ token_hash: u.api_token_hash },
      { $set: { user_id: u._id }, $setOnInsert: { name: 'Token antigo (seed)', hint: '' } }, { upsert: true });
    await User.updateOne({ _id: u._id }, { $unset: { api_token_hash: 1 } });
  }
  return users.length;
}

async function revokeAccess(userId, { keepSessionId, tokens = true } = {}) {
  const now = new Date();
  await Session.updateMany({ user_id: userId, revoked_at: null, ...(keepSessionId ? { _id: { $ne: keepSessionId } } : {}) },
    { $set: { revoked_at: now } });
  if (tokens) await ApiToken.updateMany({ user_id: userId, revoked_at: null }, { $set: { revoked_at: now } });
}

async function startSession(req, reply, user) {
  const token = newSecret();
  const now = Date.now();
  const session = await Session.create({
    user_id: user._id, token_hash: hashSecret(token), expires_at: new Date(now + SESSION_MAX_MS), ...clientInfo(req),
  });
  await User.updateOne({ _id: user._id }, { $set: { last_login_at: new Date(now) } });
  reply.header('Set-Cookie', sessionCookie(token, { secure: isHttps(req) }));
  return session;
}

async function userFromSession(req) {
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) return null;
  const session = await Session.findOne({ token_hash: hashSecret(raw) }).lean();
  if (!sessionAlive(session)) return null;
  const user = await User.findOne({ _id: session.user_id, ...active }).lean();
  if (!user) return null;
  if (Date.now() - new Date(session.last_seen_at).getTime() > TOUCH_MS) {
    await Session.updateOne({ _id: session._id }, { $set: { last_seen_at: new Date() } });
  }
  return { user, session };
}

async function userFromToken(raw) {
  if (!raw) return null;
  const token = await ApiToken.findOne({ token_hash: hashSecret(raw), revoked_at: null }).lean();
  if (!token) return null;
  const user = await User.findOne({ _id: token.user_id, ...active }).lean();
  if (!user) return null;
  if (!token.last_used_at || Date.now() - new Date(token.last_used_at).getTime() > TOUCH_MS) {
    await ApiToken.updateOne({ _id: token._id }, { $set: { last_used_at: new Date() } });
  }
  return { user, token };
}

const unauthorized = (reply, kind) => reply.code(401).send({
  error: kind === 'token' ? 'Token da extensão inválido ou revogado. Gere outro no CRM, em Minha conta.' : 'Sessão expirada. Entre de novo.',
  auth: kind,
});

// CRM: só sessão (cookie). Ações que mudam dados precisam vir da própria página.
export async function auth(req, reply) {
  const found = await userFromSession(req);
  if (!found) return unauthorized(reply, 'session');
  if (!originOk(req)) return reply.code(403).send({ error: 'Origem da requisição não permitida.' });
  req.user = found.user;
  req.session = found.session;
}

// Rotas que a extensão usa: token da extensão (Authorization: Bearer, ou ?token= no WebSocket) ou sessão do CRM.
export async function authExtension(req, reply) {
  let raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!raw && req.headers.upgrade?.toLowerCase() === 'websocket') raw = String(req.query?.token || '').trim();
  if (raw) {
    const found = await userFromToken(raw);
    if (!found) return unauthorized(reply, 'token');
    req.user = found.user;
    req.apiToken = found.token;
    return;
  }
  return auth(req, reply);
}

async function requireAdmin(req, reply) {
  if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'Só administradores.' });
}

const publicUser = (u, extra = {}) => ({
  id: u._id, name: u.name, email: u.email, role: u.role, team_id: u.team_id ?? null, active: u.active !== false,
  has_password: !!u.password_hash, last_login_at: u.last_login_at ?? null, created_at: u.created_at ?? null, ...extra,
});
const publicToken = (t) => ({ id: t._id, name: t.name, hint: t.hint || '', created_at: t.created_at, last_used_at: t.last_used_at ?? null });

export default async function authRoutes(app) {
  // ── Entrar / sair ──────────────────────────────────────────────────────────
  app.post('/auth/login', async (req, reply) => {
    if (!originOk(req)) return reply.code(403).send({ error: 'Origem da requisição não permitida.' });
    const email = normalizeEmail(req.body?.email);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const ipKey = `ip:${req.ip}`, emailKey = `email:${email}`;
    if (byIp.blocked(ipKey) || byEmail.blocked(emailKey)) {
      const wait = Math.max(byIp.retryAfterS(ipKey), byEmail.retryAfterS(emailKey));
      await logAuth(req, { email, action: 'login', ok: false, detail: 'bloqueado por excesso de tentativas' });
      return reply.code(429).header('Retry-After', wait)
        .send({ error: `Muitas tentativas. Tente de novo em ${Math.ceil(wait / 60)} min.` });
    }
    const user = email && password ? await User.findOne({ email }).lean() : null;
    const ok = user?.password_hash && user.active !== false
      ? await verifyPassword(password, user.password_hash)
      : await burnPasswordCheck(password);
    if (!ok) {
      byIp.fail(ipKey); byEmail.fail(emailKey);
      const detail = !user ? 'e-mail não cadastrado' : user.active === false ? 'usuário desativado'
        : !user.password_hash ? 'senha ainda não definida' : 'senha incorreta';
      await logAuth(req, { user, email, action: 'login', ok: false, detail });
      return reply.code(401).send({ error: 'E-mail ou senha incorretos.' });
    }
    byEmail.reset(emailKey);
    await startSession(req, reply, user);
    await logAuth(req, { user, actor: user, action: 'login' });
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (raw && originOk(req)) {
      const s = await Session.findOneAndUpdate({ token_hash: hashSecret(raw), revoked_at: null }, { $set: { revoked_at: new Date() } }).lean();
      if (s) {
        const user = await User.findById(s.user_id).lean();
        await logAuth(req, { user, actor: user, action: 'logout' });
      }
    }
    reply.header('Set-Cookie', clearSessionCookie({ secure: isHttps(req) }));
    return { ok: true };
  });

  // ── Link de definir senha (convite ou redefinição) ─────────────────────────
  const findLink = async (token) => {
    if (typeof token !== 'string' || token.length < 20) return null;
    const link = await PasswordLink.findOne({ token_hash: hashSecret(token), used_at: null, expires_at: { $gt: new Date() } }).lean();
    if (!link) return null;
    const user = await User.findOne({ _id: link.user_id, ...active }).lean();
    return user ? { link, user } : null;
  };

  app.post('/auth/password-link/check', async (req, reply) => {
    const found = await findLink(req.body?.token);
    if (!found) return reply.code(404).send({ error: 'Link inválido, já usado ou vencido. Peça um novo ao administrador.' });
    return { name: found.user.name, email: found.user.email, purpose: found.link.purpose };
  });

  app.post('/auth/password-link', async (req, reply) => {
    if (!originOk(req)) return reply.code(403).send({ error: 'Origem da requisição não permitida.' });
    const ipKey = `link:${req.ip}`;
    if (byIp.blocked(ipKey)) return reply.code(429).send({ error: 'Muitas tentativas. Tente mais tarde.' });
    const found = await findLink(req.body?.token);
    if (!found) {
      byIp.fail(ipKey);
      return reply.code(404).send({ error: 'Link inválido, já usado ou vencido. Peça um novo ao administrador.' });
    }
    const { link, user } = found;
    const problem = passwordProblem(req.body?.password, user);
    if (problem) return reply.code(400).send({ error: problem });
    // marca o link como usado antes de tudo: dois envios simultâneos não usam o mesmo link
    const claimed = await PasswordLink.updateOne({ _id: link._id, used_at: null }, { $set: { used_at: new Date() } });
    if (!claimed.modifiedCount) return reply.code(404).send({ error: 'Este link já foi usado.' });
    await User.updateOne({ _id: user._id }, { $set: { password_hash: await hashPassword(req.body.password), password_set_at: new Date() } });
    await revokeAccess(user._id, { tokens: false }); // senha nova derruba sessões antigas
    await startSession(req, reply, user);
    await logAuth(req, { user, actor: user, action: link.purpose === 'invite' ? 'password_created' : 'password_reset' });
    return { ok: true };
  });

  // ── Minha conta ────────────────────────────────────────────────────────────
  app.get('/api/me', { preHandler: auth }, async (req) => {
    const [org, team] = await Promise.all([
      Org.findById(req.user.org_id, { name: 1 }).lean(),
      req.user.team_id ? Team.findById(req.user.team_id, { name: 1 }).lean() : null,
    ]);
    return { ...publicUser(req.user), org_name: org?.name ?? '', team_name: team?.name ?? '' };
  });

  app.post('/auth/password', { preHandler: auth }, async (req, reply) => {
    const { current, password } = req.body ?? {};
    if (!(await verifyPassword(current, req.user.password_hash))) {
      await logAuth(req, { user: req.user, actor: req.user, action: 'password_change', ok: false, detail: 'senha atual incorreta' });
      return reply.code(400).send({ error: 'A senha atual está incorreta.' });
    }
    const problem = passwordProblem(password, req.user);
    if (problem) return reply.code(400).send({ error: problem });
    await User.updateOne({ _id: req.user._id }, { $set: { password_hash: await hashPassword(password), password_set_at: new Date() } });
    await revokeAccess(req.user._id, { keepSessionId: req.session._id, tokens: false });
    await logAuth(req, { user: req.user, actor: req.user, action: 'password_change' });
    return { ok: true };
  });

  app.post('/auth/sessions/revoke-others', { preHandler: auth }, async (req) => {
    await revokeAccess(req.user._id, { keepSessionId: req.session._id, tokens: false });
    await logAuth(req, { user: req.user, actor: req.user, action: 'sessions_revoked', detail: 'outros dispositivos' });
    return { ok: true };
  });

  // Tokens da extensão (um por computador)
  app.get('/api/me/tokens', { preHandler: auth }, async (req) => {
    const list = await ApiToken.find({ user_id: req.user._id, revoked_at: null }).sort({ created_at: -1 }).lean();
    return list.map(publicToken);
  });

  app.post('/api/me/tokens', { preHandler: auth }, async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
    if (!name) return reply.code(400).send({ error: 'Dê um nome ao computador (ex.: Notebook do escritório).' });
    if (await ApiToken.countDocuments({ user_id: req.user._id, revoked_at: null }) >= MAX_TOKENS_PER_USER) {
      return reply.code(400).send({ error: `Limite de ${MAX_TOKENS_PER_USER} tokens ativos. Revogue algum antes.` });
    }
    const token = newSecret('spc_');
    const doc = await ApiToken.create({ user_id: req.user._id, name, token_hash: hashSecret(token), hint: token.slice(-4) });
    await logAuth(req, { user: req.user, actor: req.user, action: 'token_created', detail: name });
    return { ...publicToken(doc), token }; // o valor só aparece agora
  });

  app.delete('/api/me/tokens/:id', { preHandler: auth }, async (req, reply) => {
    if (!idOk(req.params.id)) return reply.code(404).send({ error: 'Token não encontrado.' });
    const t = await ApiToken.findOneAndUpdate({ _id: req.params.id, user_id: req.user._id, revoked_at: null },
      { $set: { revoked_at: new Date() } }).lean();
    if (!t) return reply.code(404).send({ error: 'Token não encontrado.' });
    await logAuth(req, { user: req.user, actor: req.user, action: 'token_revoked', detail: t.name });
    return { ok: true };
  });

  // A extensão confere o token e mostra para quem ele foi emitido
  app.get('/api/extension/me', { preHandler: authExtension }, async (req) => ({ name: req.user.name, email: req.user.email }));

  // ── Administração (só admin, só a própria conta) ───────────────────────────
  const admin = { preHandler: [auth, requireAdmin] };
  const orgUser = (req) => User.findOne({ _id: req.params.id, org_id: req.user.org_id });
  const validTeam = async (req, teamId) => teamId == null || teamId === ''
    || (idOk(teamId) && !!(await Team.exists({ _id: teamId, org_id: req.user.org_id })));
  const otherActiveAdmins = (req, exceptId) =>
    User.countDocuments({ org_id: req.user.org_id, role: 'admin', ...active, _id: { $ne: exceptId } });

  app.get('/api/admin/users', admin, async (req) => {
    const users = await User.find({ org_id: req.user.org_id }).sort({ name: 1 }).lean();
    const ids = users.map((u) => u._id);
    const now = new Date();
    const [tokens, sessions] = await Promise.all([
      ApiToken.aggregate([{ $match: { user_id: { $in: ids }, revoked_at: null } }, { $group: { _id: '$user_id', n: { $sum: 1 } } }]),
      Session.aggregate([{ $match: { user_id: { $in: ids }, revoked_at: null, expires_at: { $gt: now } } }, { $group: { _id: '$user_id', n: { $sum: 1 } } }]),
    ]);
    const count = (list) => new Map(list.map((x) => [String(x._id), x.n]));
    const t = count(tokens), s = count(sessions);
    return users.map((u) => publicUser(u, { tokens: t.get(String(u._id)) || 0, sessions: s.get(String(u._id)) || 0 }));
  });

  app.post('/api/admin/users', admin, async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
    const email = normalizeEmail(req.body?.email);
    const role = req.body?.role || 'seller';
    const team_id = req.body?.team_id || null;
    if (!name || !validEmail(email)) return reply.code(400).send({ error: 'Informe nome e um e-mail válido.' });
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'Papel inválido.' });
    if (!(await validTeam(req, team_id))) return reply.code(400).send({ error: 'Time inválido.' });
    if (await User.exists({ email })) return reply.code(409).send({ error: 'Já existe um usuário com esse e-mail.' });
    const user = await User.create({ org_id: req.user.org_id, name, email, role, team_id });
    const link = await createPasswordLink(user, { createdBy: req.user });
    await logAuth(req, { user, actor: req.user, action: 'user_invited', detail: role });
    return { user: publicUser(user.toObject()), link };
  });

  app.patch('/api/admin/users/:id', admin, async (req, reply) => {
    if (!idOk(req.params.id)) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    const user = await orgUser(req);
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    const b = req.body ?? {};
    const self = String(user._id) === String(req.user._id);
    const changes = [];
    if (typeof b.name === 'string' && b.name.trim() && b.name.trim() !== user.name) { user.name = b.name.trim().slice(0, 100); changes.push('nome'); }
    if ('team_id' in b && String(b.team_id || '') !== String(user.team_id || '')) {
      if (!(await validTeam(req, b.team_id))) return reply.code(400).send({ error: 'Time inválido.' });
      user.team_id = b.team_id || null; changes.push('time');
    }
    if (b.role !== undefined && b.role !== user.role) {
      if (!ROLES.includes(b.role)) return reply.code(400).send({ error: 'Papel inválido.' });
      if (self) return reply.code(400).send({ error: 'Você não pode mudar o seu próprio papel.' });
      if (user.role === 'admin' && !(await otherActiveAdmins(req, user._id))) return reply.code(400).send({ error: 'A conta precisa de pelo menos um admin ativo.' });
      changes.push(`papel ${user.role} → ${b.role}`); user.role = b.role;
    }
    if (typeof b.active === 'boolean' && b.active !== (user.active !== false)) {
      if (self) return reply.code(400).send({ error: 'Você não pode desativar a si mesmo.' });
      if (!b.active && user.role === 'admin' && !(await otherActiveAdmins(req, user._id))) return reply.code(400).send({ error: 'A conta precisa de pelo menos um admin ativo.' });
      user.active = b.active; changes.push(b.active ? 'reativado' : 'desativado');
    }
    if (!changes.length) return { user: publicUser(user.toObject()) };
    await user.save();
    if (user.active === false) {
      await revokeAccess(user._id);
      await PasswordLink.updateMany({ user_id: user._id, used_at: null }, { $set: { used_at: new Date() } });
    }
    await logAuth(req, { user, actor: req.user, action: 'user_updated', detail: changes.join(', ') });
    return { user: publicUser(user.toObject()) };
  });

  app.post('/api/admin/users/:id/password-link', admin, async (req, reply) => {
    if (!idOk(req.params.id)) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    const user = await orgUser(req);
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    if (user.active === false) return reply.code(400).send({ error: 'Reative o usuário antes de gerar o link.' });
    const link = await createPasswordLink(user, { createdBy: req.user });
    await logAuth(req, { user, actor: req.user, action: 'password_link', detail: user.password_hash ? 'redefinição' : 'convite' });
    return { link };
  });

  app.post('/api/admin/users/:id/revoke', admin, async (req, reply) => {
    if (!idOk(req.params.id)) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    const user = await orgUser(req);
    if (!user) return reply.code(404).send({ error: 'Usuário não encontrado.' });
    if (String(user._id) === String(req.user._id)) return reply.code(400).send({ error: 'Para você mesmo, use "Sair dos outros dispositivos" em Minha conta.' });
    await revokeAccess(user._id);
    await logAuth(req, { user, actor: req.user, action: 'sessions_revoked', detail: 'sessões e tokens da extensão' });
    return { ok: true };
  });

  app.get('/api/admin/teams', admin, async (req) =>
    (await Team.find({ org_id: req.user.org_id }).sort({ name: 1 }).lean()).map((t) => ({ id: t._id, name: t.name })));

  app.post('/api/admin/teams', admin, async (req, reply) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
    if (!name) return reply.code(400).send({ error: 'Informe o nome do time.' });
    if (await Team.exists({ org_id: req.user.org_id, name })) return reply.code(409).send({ error: 'Já existe um time com esse nome.' });
    const t = await Team.create({ org_id: req.user.org_id, name });
    await logAuth(req, { actor: req.user, action: 'team_created', detail: name });
    return { id: t._id, name: t.name };
  });

  app.get('/api/admin/events', admin, async (req) => {
    const list = await AuthEvent.find({ org_id: req.user.org_id }).sort({ at: -1 }).limit(100).lean();
    const ids = [...new Set(list.flatMap((e) => [e.user_id, e.actor_id]).filter(Boolean).map(String))];
    const names = new Map((await User.find({ _id: { $in: ids } }, { name: 1 }).lean()).map((u) => [String(u._id), u.name]));
    return list.map((e) => ({
      at: e.at, action: e.action, ok: e.ok, detail: e.detail || '', ip: e.ip || '', email: e.email || '',
      user_name: names.get(String(e.user_id)) || '', actor_name: names.get(String(e.actor_id)) || '',
    }));
  });
}
