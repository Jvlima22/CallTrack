// Liga painel + captura de legendas + backend. Não grava áudio: só lê o texto das legendas.
(async function () {
  const MEETING_RE = /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
  if (!MEETING_RE.test(location.pathname)) return;

  const DEFAULT_SELECTORS = {
    region: ['div[role="region"][aria-label*="Legendas" i]', 'div[role="region"][aria-label*="Captions" i]'],
    block: [':scope > div'],
    speaker: ['span'],
    text: ['div:last-child'],
    captionsButton: ['button[aria-label*="legendas" i]', 'button[aria-label*="captions" i]'],
    selfLabels: ['Você', 'You'],
    participantTile: ['[data-participant-id]', '[data-requested-participant-id]'],
    participantName: ['[data-self-name]', '.zWGUib', '.XEazBc', '.dwSJ2e'],
    participantAvatar: ['img[src*="googleusercontent.com"]'],
    selfTile: ['[data-self-name]'],
    meetingTitle: ['[data-meeting-title]'],
    micButton: ['button[data-is-muted][aria-label*="microfone" i]', 'button[data-is-muted][aria-label*="microphone" i]'],
  };

  const cfg = await chrome.storage.sync.get(['backendUrl', 'token']);
  const base = (cfg.backendUrl || '').replace(/\/$/, '');
  const panel = CallTrackPanel.createPanel({ 
    onStart: start, 
    onEnd: () => end('manual'),
    // o CRM tem login próprio (e-mail e senha); o token da extensão não abre o CRM
    onCrm: () => window.open(`${base}/`, '_blank')
  });
  if (!cfg.backendUrl || !cfg.token) {
    panel.setState('error', 'Configure o servidor e o token no ícone da extensão. O token é gerado no CRM, em Minha conta.');
    return;
  }

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` };

  let S = DEFAULT_SELECTORS;
  try {
    const r = await fetch(`${base}/config/meet-selectors`);
    if (r.ok) S = { ...DEFAULT_SELECTORS, ...(await r.json()) };
  } catch { /* usa os padrões */ }

  let callId = null;
  let ws = null;
  let tracker = null;
  let observer = null;
  let timers = [];
  let queue = []; // falas ainda não confirmadas pelo servidor
  let ended = false;
  let lastCaptionAt = 0;
  let reconnectDelay = 1000;
  const CALL_ENDED_CODE = 4000; // servidor fechou porque a call acabou
  let recording = null; // { recorder, close, streams, micTimer }

  const first = (el, list) => {
    for (const sel of list) {
      try { const f = el.querySelector(sel); if (f) return f; } catch { /* seletor inválido */ }
    }
    return null;
  };
  const all = (el, list) => {
    for (const sel of list) {
      try { const f = el.querySelectorAll(sel); if (f.length) return [...f]; } catch { /* seletor inválido */ }
    }
    return [];
  };

  function snapshot(region) {
    return all(region, S.block).map((block) => {
      const sp = first(block, S.speaker);
      const tx = first(block, S.text);
      return { key: block, speaker: sp?.textContent?.trim() ?? '', text: tx?.textContent ?? '' };
    }).filter((b) => b.text.trim());
  }

  // ─── Participantes e título da reunião ─────────────────────────────────────
  // O Meet só mostra nome e foto dos outros participantes (sem e-mail/telefone).
  const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  // O Meet repete o nome no mesmo elemento ("AnaAna"): fica só uma vez
  const undouble = (t) => { const m = clean(t).match(/^(.+?)\s?\1$/); return m && m[1].trim().length >= 2 ? m[1].trim() : clean(t); };

  function readParticipants() {
    const byName = new Map();
    let selfName = null;
    for (const tile of all(document, S.participantTile)) {
      const nameEl = first(tile, S.participantName);
      const name = undouble(nameEl?.getAttribute?.('data-self-name') || nameEl?.textContent);
      if (!name || name.length > 120) continue;
      const isSelf = !!first(tile, S.selfTile);
      if (isSelf) selfName = name;
      const avatar = first(tile, S.participantAvatar)?.src || '';
      const prev = byName.get(name);
      byName.set(name, { name, is_self: isSelf || !!prev?.is_self, avatar_url: prev?.avatar_url || avatar });
    }
    return { selfName, participants: [...byName.values()] };
  }

  function readMeetingTitle() {
    const el = first(document, S.meetingTitle);
    const fromAttr = clean(el?.getAttribute?.('data-meeting-title') || el?.textContent);
    if (fromAttr) return fromAttr;
    // aba do Chrome: "Meet: <título>" (sem título, mostra o código da reunião)
    const t = clean(document.title.replace(/^Meet\s*[:\-–]\s*/i, ''));
    return t && t !== location.pathname.slice(1) && !/^google meet$/i.test(t) ? t : '';
  }

  let lastParticipantsJson = '';
  function sendParticipants(force = false) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const { selfName, participants } = readParticipants();
    const payload = { type: 'participants.update', self_name: selfName, meeting_title: readMeetingTitle(), participants };
    const json = JSON.stringify(payload);
    if (!force && json === lastParticipantsJson) return;
    lastParticipantsJson = json;
    ws.send(json);
  }

  // Diz ao servidor se as legendas foram encontradas (vira a cor cinza do badge no CRM).
  let captionsFound = false;
  function sendCaptureStatus() {
    captionsFound = !!first(document, S.region);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'capture.status', captions_found: captionsFound }));
  }

  function enableCaptions() {
    const btn = first(document, S.captionsButton);
    if (btn && btn.getAttribute('aria-pressed') === 'false') btn.click();
  }

  function watchCaptions() {
    const attach = () => {
      const region = first(document, S.region);
      if (!region) return false;
      observer = new MutationObserver(() => {
        lastCaptionAt = Date.now();
        tracker.update(snapshot(region));
      });
      observer.observe(region, { childList: true, subtree: true, characterData: true });
      return true;
    };
    if (!attach()) {
      const poll = setInterval(() => { enableCaptions(); if (attach()) clearInterval(poll); }, 1000);
      timers.push(poll);
    }
  }

  function send() {
    if (!queue.length || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'turns.append', turns: queue.slice(0, 50) }));
  }

  function connect() {
    const url = `${base.replace(/^http/, 'ws')}/ws/calls/${callId}?token=${encodeURIComponent(cfg.token)}`;
    ws = new WebSocket(url);
    ws.onopen = () => { reconnectDelay = 1000; send(); sendParticipants(true); sendCaptureStatus(); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'stages.update') panel.setStages(msg.stages);
      if (msg.type === 'suggestion.new') panel.setSuggestion(msg.suggestion);
      if (msg.type === 'turns.ack') queue = queue.filter((t) => t.seq > msg.upTo);
      if (msg.type === 'case.request') panel.setSuggestion({ text: 'O lead pediu um exemplo parecido. Cite um case do mesmo segmento.' });
      if (msg.type === 'hello') { sendParticipants(true); sendCaptureStatus(); }
      if (msg.type === 'error') console.warn('[CallTrack]', msg.message);
    };
    ws.onclose = async (ev) => {
      if (ended) return;
      if (ev.code === CALL_ENDED_CODE) return stopLocal('Call encerrada pelo servidor. O relatório fica pronto em alguns minutos.');
      // Antes de reconectar, confere o motivo: token inválido ou call encerrada não adiantam insistir.
      const why = await callState();
      if (ended) return;
      if (why === 'unauthorized') return stopLocal(null, 'Token inválido ou revogado. Gere outro no CRM (Minha conta) e cole no ícone da extensão.');
      if (why === 'ended') return stopLocal('Esta call já foi encerrada. O relatório fica pronto em alguns minutos.');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    };
  }

  // ─── Gravação de vídeo ─────────────────────────────────────────────────────
  // O pedido de compartilhamento da aba precisa sair no próprio clique (regra do Chrome),
  // por isso start() chama requestDisplay() antes de qualquer outra coisa.
  function requestDisplay() {
    return navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 24 } },
      audio: { suppressLocalAudioPlayback: false },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'include',
    });
  }

  // Microfone acompanha o botão de mudo do Meet: com o Meet no mudo, nada do seu microfone é gravado.
  function meetMuted() {
    const btn = first(document, S.micButton || []);
    return btn ? btn.getAttribute('data-is-muted') === 'true' : false;
  }

  async function startRecording(displayPromise, consentText, captureStartedAt) {
    let display;
    try {
      display = await displayPromise;
    } catch {
      panel.setSuggestion({ text: 'Gravação cancelada. A análise continua, sem vídeo.' });
      return;
    }
    let mic = null;
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { /* sem microfone: grava só a aba */ }
    const { stream, close } = CallTrackRecorder.mixStreams({ display, mic, kind: 'video' });
    const micTrack = mic?.getAudioTracks()[0];
    const micTimer = micTrack ? setInterval(() => { micTrack.enabled = !meetMuted(); }, 500) : null;

    let startInfo;
    try {
      const r = await fetch(`${base}/calls/${callId}/recording/start`, {
        method: 'POST', headers,
        body: JSON.stringify({ kind: 'video', mime: CallTrackRecorder.pickMime('video'), offset_ms: Date.now() - captureStartedAt, consent: { confirmed: true, text: consentText } }),
      });
      startInfo = await r.json();
      if (!r.ok) throw new Error(startInfo.error || `Erro ${r.status}`);
    } catch (err) {
      [display, mic].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
      clearInterval(micTimer); close();
      panel.setSuggestion({ text: `Não foi possível iniciar a gravação: ${err.message}` });
      return;
    }

    const recorder = CallTrackRecorder.createRecorder({
      stream, kind: 'video', startSeq: startInfo.next_seq ?? 0,
      upload: async (seq, blob) => {
        const r = await fetch(`${base}/calls/${callId}/recording/chunks/${seq}`, {
          method: 'PUT', headers: { Authorization: headers.Authorization, 'Content-Type': 'application/octet-stream' }, body: blob,
        });
        if (r.status === 409) return; // gravação já encerrada no servidor: descarta
        if (!r.ok) throw new Error(`Erro ${r.status}`);
      },
      onState: (st) => {
        if (st.error) panel.setRecording(true, { warn: true, title: `Falha ao enviar o vídeo; tentando de novo (${st.pending} pedaços na fila)` });
        else if (st.uploaded !== undefined || st.recording) panel.setRecording(true);
        if (st.dropped) panel.setRecording(true, { warn: true, title: 'Servidor fora do ar há muito tempo: parte do vídeo foi descartada' });
      },
    });
    recording = { recorder, close, streams: [display, mic], micTimer };
    // "Parar de compartilhar" na barra do Chrome encerra só a gravação; a análise continua
    display.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (!ended) void stopRecording().then(() => panel.setSuggestion({ text: 'Gravação encerrada. A análise continua.' }));
    });
    recorder.start();
  }

  async function stopRecording() {
    const rec = recording;
    if (!rec) return;
    recording = null;
    const { durationMs } = await rec.recorder.stop();
    rec.streams.forEach((s) => s?.getTracks().forEach((t) => t.stop()));
    clearInterval(rec.micTimer);
    rec.close();
    panel.setRecording(false);
    await fetch(`${base}/calls/${callId}/recording/finish`, { method: 'POST', headers, body: JSON.stringify({ duration_ms: durationMs }) }).catch(() => {});
  }

  // 'live' | 'ended' | 'unauthorized' | 'offline' (servidor fora do ar: continua tentando)
  async function callState() {
    try {
      const r = await fetch(`${base}/calls/${callId}`, { headers });
      if (r.status === 401 || r.status === 403) return 'unauthorized';
      if (r.status === 404) return 'ended';
      const body = await r.json();
      return body.call?.status === 'live' ? 'live' : 'ended';
    } catch {
      return 'offline';
    }
  }

  // Para a captura sem chamar /end (a call já foi encerrada no servidor ou o token não vale).
  function stopLocal(endedMessage, errorMessage) {
    ended = true;
    void stopRecording();
    observer?.disconnect();
    timers.forEach(clearInterval);
    try { ws?.close(); } catch { /* já fechado */ }
    if (errorMessage) panel.setState('error', errorMessage);
    else panel.setState('ended', endedMessage);
  }

  async function start({ record = false, consentText = '' } = {}) {
    // Primeiro de tudo: pedido de compartilhamento da aba (tem que sair no clique)
    const displayPromise = record ? requestDisplay() : null;
    displayPromise?.catch(() => {}); // tratado em startRecording
    // "Tentar de novo" depois de um erro começa uma captura limpa
    timers.forEach(clearInterval);
    observer?.disconnect();
    ended = false; queue = []; timers = []; reconnectDelay = 1000; lastParticipantsJson = '';
    panel.setState('connecting');
    try {
      const r = await fetch(`${base}/calls`, {
        method: 'POST', headers, body: JSON.stringify({ meeting_code: location.pathname.slice(1) }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `Erro ${r.status}`);
      callId = body.call_id;
      panel.setPlaybook(body.playbook.name, body.playbook.stages);
      panel.setMeta(`${body.seller_name} · ${callId.slice(0, 8)}`);
      panel.setState('live', 'Ouvindo. As sugestões aparecem aqui.');

      const startedAt = Date.now();
      lastCaptionAt = startedAt;
      tracker = new CallTrackCaptions.CaptionTracker({
        startedAt,
        onCommit: (t) => queue.push({ ...t, role: CallTrackCaptions.roleFor(t.speaker_name, S.selfLabels) }),
      });
      enableCaptions();
      watchCaptions();
      connect();
      if (displayPromise) void startRecording(displayPromise, consentText, startedAt);
      timers.push(setInterval(() => tracker.tick(), 500));
      timers.push(setInterval(send, 5000));
      // a cada 5 s manda se mudou; a cada 30 s manda de qualquer jeito (se perder uma, recupera)
      let beat = 0;
      timers.push(setInterval(() => { beat += 1; sendParticipants(beat % 6 === 0); }, 5000));
      timers.push(setInterval(sendCaptureStatus, 10000));
      // Saúde da captura: legendas não encontradas, ou nenhuma legenda nova por 60 s.
      timers.push(setInterval(() => {
        if (!first(document, S.region)) {
          panel.setSuggestion({ text: 'Legendas do Meet não encontradas. Ative as legendas em português (tecla C).' });
        } else if (Date.now() - lastCaptionAt > 60000) {
          panel.setSuggestion({ text: 'Nenhuma legenda nova há 1 min. Confira se as legendas estão ativas (tecla C).' });
          lastCaptionAt = Date.now();
        }
      }, 10000));
    } catch (err) {
      panel.setState('error', `Não foi possível iniciar: ${err.message}`);
    }
  }

  async function end(reason) {
    if (!callId || ended) return;
    ended = true;
    tracker?.flush();
    send();
    observer?.disconnect();
    timers.forEach(clearInterval);
    if (reason !== 'unload') {
      if (recording) panel.setState('connecting');
      await stopRecording(); // envia o último pedaço do vídeo antes de encerrar
    }
    // pequena espera para o último lote chegar antes de encerrar
    await new Promise((r) => setTimeout(r, reason === 'unload' ? 0 : 1500));
    fetch(`${base}/calls/${callId}/end`, { method: 'POST', headers, body: '{}', keepalive: true }).catch(() => {});
    ws?.close();
    panel.setState('ended');
  }

  window.addEventListener('pagehide', () => end('unload'));
})();
