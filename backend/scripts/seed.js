// Uso: node scripts/seed.js "Nome da Empresa" "Nome do Vendedor" email@empresa.com [seller|manager|admin]
// Cria a conta (se não existir), o playbook SPICED padrão e o usuário.
// Imprime o token da extensão uma única vez.
import 'dotenv/config';
import crypto from 'node:crypto';
import { connectDb, hashToken } from '../src/db.js';
import { Org, User, Playbook } from '../src/models.js';
import { DEFAULT_SPICED } from '../src/playbook.js';

const [orgName, userName, email, role = 'seller'] = process.argv.slice(2);
if (!orgName || !userName || !email) {
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

const token = `spc_${crypto.randomBytes(24).toString('hex')}`;
await User.findOneAndUpdate(
  { email },
  { org_id: org._id, role, name: userName, email, api_token_hash: hashToken(token) },
  { upsert: true, new: true },
);
console.log(`Usuário ${userName} (${role}) pronto.`);
console.log(`Token da extensão (guarde agora, não é exibido de novo):\n${token}`);

process.exit(0);
