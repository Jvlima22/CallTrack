const url = document.getElementById('url');
const token = document.getElementById('token');
const status = document.getElementById('status');

chrome.storage.sync.get(['backendUrl', 'token']).then((c) => {
  url.value = c.backendUrl || '';
  token.value = c.token || '';
});

// Confere servidor e token antes de salvar, e mostra para quem o token foi emitido
document.getElementById('save').addEventListener('click', async () => {
  const backendUrl = url.value.trim().replace(/\/+$/, '');
  const value = token.value.trim();
  if (!backendUrl || !value) { status.textContent = 'Preencha o servidor e o token.'; return; }
  status.textContent = 'Conferindo…';
  let r;
  try {
    r = await fetch(`${backendUrl}/api/extension/me`, { headers: { Authorization: `Bearer ${value}` } });
  } catch {
    status.textContent = 'Servidor não respondeu. Confira o endereço e se o backend está rodando.';
    return;
  }
  if (r.status === 401) { status.textContent = 'Token inválido ou revogado. Gere outro no CRM, em Minha conta.'; return; }
  if (!r.ok) { status.textContent = `O servidor respondeu com erro ${r.status}. Confira o endereço.`; return; }
  const me = await r.json().catch(() => ({}));
  await chrome.storage.sync.set({ backendUrl, token: value });
  status.textContent = `Conectado como ${me.name || 'usuário'}${me.email ? ` (${me.email})` : ''}. Recarregue a aba do Meet para aplicar.`;
});
