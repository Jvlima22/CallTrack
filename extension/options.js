const url = document.getElementById('url');
const token = document.getElementById('token');
const status = document.getElementById('status');

chrome.storage.sync.get(['backendUrl', 'token']).then((c) => {
  url.value = c.backendUrl || '';
  token.value = c.token || '';
});

document.getElementById('save').addEventListener('click', async () => {
  const backendUrl = url.value.trim().replace(/\/$/, '');
  try {
    const r = await fetch(`${backendUrl}/health`);
    if (!r.ok) throw new Error();
    await chrome.storage.sync.set({ backendUrl, token: token.value.trim() });
    status.textContent = 'Salvo. Recarregue a aba do Meet para aplicar.';
  } catch {
    status.textContent = 'Servidor não respondeu. Confira o endereço e se o backend está rodando.';
  }
});
