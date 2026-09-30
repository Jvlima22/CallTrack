// Transforma as legendas do Meet (que se reescrevem enquanto a pessoa fala) em falas confirmadas.
// Regra (seção 5): um bloco é confirmado quando surge um bloco novo depois dele (troca de falante)
// ou quando fica STABLE_MS sem mudar. Se o mesmo bloco continuar crescendo depois de confirmado,
// o trecho novo vira outra fala.
//
// Compatível com dois ambientes:
//   Browser (content script MV3): expõe self.CallTrackCaptions
//   Node.js (testes via createRequire): expõe via module.exports

const STABLE_MS = 1500;

class CaptionTracker {
  constructor({ onCommit, now = () => Date.now(), stableMs = STABLE_MS, startedAt = now() }) {
    this.onCommit = onCommit;
    this.now = now;
    this.stableMs = stableMs;
    this.startedAt = startedAt;
    this.blocks = new Map(); // key (elemento do DOM) -> estado
    this.order = []; // chaves na ordem em que apareceram
    this.seq = 0;
  }

  // snapshot: [{ key, speaker, text }] na ordem em que aparecem na tela
  update(snapshot) {
    const t = this.now();
    for (const { key, speaker, text } of snapshot) {
      const clean = (text || '').replace(/\s+/g, ' ').trim();
      let b = this.blocks.get(key);
      if (!b) {
        // bloco novo: confirma tudo que estava antes dele
        for (const k of this.order) this._commit(this.blocks.get(k), t);
        b = { speaker, text: '', committedLen: 0, firstSeen: t, lastChange: t, turnStart: t };
        this.blocks.set(key, b);
        this.order.push(key);
      }
      if (clean !== b.text) {
        // O Meet corrige palavras já exibidas; se o texto encolheu antes do ponto confirmado, reancora.
        if (clean.length < b.committedLen) b.committedLen = clean.length;
        if (b.committedLen === b.text.length && clean.length > b.committedLen) b.turnStart = t;
        b.text = clean;
        b.speaker = speaker || b.speaker;
        b.lastChange = t;
      }
    }
    this.tick();
  }

  // chamar periodicamente para confirmar blocos parados
  tick() {
    const t = this.now();
    for (const k of this.order) {
      const b = this.blocks.get(k);
      if (t - b.lastChange >= this.stableMs) this._commit(b, t);
    }
    // limpa blocos antigos já confirmados por completo
    if (this.order.length > 50) {
      const drop = this.order.splice(0, this.order.length - 50);
      for (const k of drop) this.blocks.delete(k);
    }
  }

  flush() {
    const t = this.now();
    for (const k of this.order) this._commit(this.blocks.get(k), t);
  }

  _commit(b, t) {
    if (!b || b.text.length <= b.committedLen) return;
    const piece = b.text.slice(b.committedLen).trim();
    b.committedLen = b.text.length;
    if (!piece) return;
    this.onCommit({
      seq: this.seq++,
      speaker_name: b.speaker,
      text: piece,
      started_ms: Math.max(0, b.turnStart - this.startedAt),
      ended_ms: Math.max(0, Math.min(t, b.lastChange) - this.startedAt),
    });
  }
}

// Papel pela etiqueta do falante: "Você"/"You" = vendedor; resto = lead.
function roleFor(speaker, selfLabels) {
  const s = (speaker || '').trim().toLowerCase();
  return selfLabels.some((l) => l.toLowerCase() === s) ? 'seller' : 'lead';
}

const CallTrackCaptionsApi = { CaptionTracker, roleFor, STABLE_MS };

// Node.js (CommonJS via createRequire nos testes)
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = CallTrackCaptionsApi;
}

// Browser (content script MV3) — self = window no browser
if (typeof self !== 'undefined') {
  self.CallTrackCaptions = CallTrackCaptionsApi;
}
