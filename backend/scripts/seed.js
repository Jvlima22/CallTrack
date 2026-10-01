// Uso: node scripts/seed.js "Nome da Empresa" "Nome" email@empresa.com [seller|manager|admin]
// Cria a conta (se não existir), o playbook SPICED padrão e o usuário, e imprime o link para a pessoa
// definir a senha (uso único, vale 7 dias). Serve para criar o primeiro admin; os demais usuários
// são convidados pelo CRM, em Usuários.
// Rodar de novo com o mesmo e-mail gera um link novo (para quem esqueceu a senha) sem mexer no resto.
import 'dotenv/config';
import { connectDb } from '../src/db.js';
import { Org, User, Playbook } from '../src/models.js';
import { DEFAULT_SPICED } from '../src/playbook.js';
import { createPasswordLink, logAuth } from '../src/auth.js';
import { normalizeEmail, validEmail } from '../src/authLogic.js';

const [orgName, userName, rawEmail, role = 'seller'] = process.argv.slice(2);
const email = normalizeEmail(rawEmail);
if (!orgName || !userName || !validEmail(email) || !['seller', 'manager', 'admin'].includes(role)) {
  console.error('Uso: node scripts/seed.js "Empresa" "Nome" email@empresa.com [seller|manager|admin]');
  process.exit(1);
}

await connectDb();

let org = await Org.findOne({ name: orgName }).lean();
if (!org) {
  org = await Org.create({ name: orgName, email_domain: email.split('@')[1] });
  await Playbook.create({
    org_id:     org._id,
    name:       DEFAULT_SPICED.name,
    version:    DEFAULT_SPICED.version,
    definition: DEFAULT_SPICED,
    is_default: true,
  });
  console.log(`Conta criada: ${org.name}`);
}

let user = await User.findOne({ email });
if (user && String(user.org_id) !== String(org._id)) {
  console.error(`O e-mail ${email} já pertence a outra conta. Nada foi alterado.`);
  process.exit(1);
}
if (!user) {
  user = await User.create({ org_id: org._id, role, name: userName, email });
  console.log(`Usuário ${userName} (${role}) criado.`);
} else {
  user.name = userName; user.role = role; user.active = true;
  await user.save();
  console.log(`Usuário ${userName} (${role}) atualizado e ativo.`);
}

const link = await createPasswordLink(user);
await logAuth(null, { user, action: 'password_link', detail: 'gerado pelo seed' });
const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/+$/, '');
console.log(`\nLink para definir a senha (uso único, vale até ${link.expires_at.toLocaleString('pt-BR')}):\n${base}${link.path}`);
console.log('\nSe o CRM for aberto por outro endereço (ex.: o do túnel), troque só o começo do link e mantenha a parte a partir de /#senha=.');

process.exit(0);
