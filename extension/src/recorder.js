// Gravação da call: aba do Meet (vídeo + áudio dos outros participantes) misturada com o
// microfone do vendedor, gravada em pedaços de 10 s e enviada ao servidor.
// Expõe self.CallTrackRecorder. Sem dependência do Meet: recebe as streams prontas.
(function (root) {
  const TIMESLICE_MS = 10_000;
  const MAX_BUFFER_BYTES = 200 * 1024 * 1024; // pedaços esperando envio (servidor fora do ar)

  function pickMime(kind) {
    const list = kind === 'audio'
      ? ['audio/webm;codecs=opus', 'audio/webm']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find((m) => root.MediaRecorder?.isTypeSupported?.(m)) || '';
  }

  // Junta o vídeo da aba e os dois áudios (aba + microfone) numa stream só.
  function mixStreams({ display, mic, kind = 'video' }) {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    for (const s of [display, mic]) {
      if (s?.getAudioTracks().length) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);
    }
    const tracks = [...dest.stream.getAudioTracks()];
    if (kind === 'video') tracks.unshift(...(display?.getVideoTracks() ?? []));
    return { stream: new MediaStream(tracks), close: () => ctx.close().catch(() => {}) };
  }

  // upload(seq, blob) -> Promise (rejeita em falha: o pedaço volta para a fila)
  function createRecorder({ stream, kind = 'video', upload, onState = () => {}, startSeq = 0 }) {
    const mimeType = pickMime(kind);
    const rec = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 1_000_000,
      audioBitsPerSecond: 64_000,
    });
    let seq = startSeq;
    let startedAt = 0;
    let buffered = 0;
    let sending = false;
    let dropped = 0;
    const queue = []; // { seq, blob, tries }
    let stopResolve = null;

    async function pump() {
      if (sending) return;
      sending = true;
      while (queue.length) {
        const item = queue[0];
        try {
          await upload(item.seq, item.blob);
          queue.shift();
          buffered -= item.blob.size;
          onState({ uploaded: item.seq, pending: queue.length });
        } catch {
          item.tries += 1;
          onState({ error: true, pending: queue.length });
          await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(item.tries, 5))));
          if (rec.state === 'inactive' && item.tries > 8) break; // desiste ao encerrar
        }
      }
      sending = false;
      if (stopResolve && !queue.length) stopResolve();
    }

    rec.ondataavailable = (ev) => {
      if (!ev.data?.size) return;
      if (buffered + ev.data.size > MAX_BUFFER_BYTES) { dropped += 1; onState({ dropped }); return; }
      queue.push({ seq: seq++, blob: ev.data, tries: 0 });
      buffered += ev.data.size;
      void pump();
    };
    rec.onstart = () => { startedAt = Date.now(); onState({ recording: true }); };

    return {
      mimeType: rec.mimeType || mimeType,
      get startedAt() { return startedAt; },
      get state() { return rec.state; },
      start() { rec.start(TIMESLICE_MS); },
      // Para, envia o último pedaço e espera a fila esvaziar (até timeoutMs).
      stop(timeoutMs = 15_000) {
        return new Promise((resolve) => {
          const done = () => resolve({ durationMs: startedAt ? Date.now() - startedAt : 0, pending: queue.length, dropped });
          const t = setTimeout(done, timeoutMs);
          stopResolve = () => { clearTimeout(t); done(); };
          if (rec.state !== 'inactive') {
            rec.addEventListener('stop', () => setTimeout(() => { if (!queue.length && !sending) stopResolve(); else void pump(); }, 0), { once: true });
            rec.stop();
          } else if (!queue.length) stopResolve();
        });
      },
    };
  }

  root.CallTrackRecorder = { pickMime, mixStreams, createRecorder, TIMESLICE_MS };
})(self);
