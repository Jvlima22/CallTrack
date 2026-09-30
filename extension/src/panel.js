// Painel do CallTrack dentro do Meet. Shadow DOM para o CSS do Meet não vazar.
// O usuário pode arrastar (alça à esquerda) e redimensionar (bordas de cima/direita e canto);
// posição e tamanho ficam salvos em chrome.storage.local.
(function (root) {
  const STATUS_LABEL = { none: 'Não abordado', partial: 'Parcial', complete: 'Completo' };
  const STORE_KEY = 'ctPanelLayout';
  const MARGIN = 8;          // distância mínima da borda da janela
  const MIN_W = 360;
  const MIN_H = 52;
  const TALL_H = 104;        // a partir daqui a sugestão ganha uma linha própria

  const CSS = `
  :host { all: initial; }
  .bar {
    --s: 1;
    position: fixed; left: 16px; bottom: 88px; z-index: 2147483000;
    box-sizing: border-box;
    display: flex; flex-wrap: wrap; align-items: center; align-content: center; gap: 10px 14px;
    max-width: calc(100vw - ${MARGIN * 2}px); max-height: calc(100vh - ${MARGIN * 2}px);
    padding: 10px 12px 10px 14px; border-radius: 12px; overflow: hidden;
    background: #202124; border: 1px solid #3c4043; color: #e8eaed;
    font: calc(13px * var(--s))/1.35 "Google Sans", Roboto, Arial, sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,.35);
  }
  .bar:not(.sized) { max-width: min(960px, calc(100vw - ${MARGIN * 2}px)); }
  .bar.tall { align-content: flex-start; }
  .bar.tall .insight { order: 10; flex-basis: 100%; font-size: calc(15px * var(--s)); line-height: 1.4; overflow: auto; }
  .bar.collapsed { width: auto !important; height: auto !important; }
  .bar.collapsed .stages, .bar.collapsed .insight, .bar.collapsed .meta, .bar.collapsed .start,
  .bar.collapsed .end, .bar.collapsed .rz { display: none !important; }
  .drag-handle {
    cursor: grab; display: flex; align-items: center; justify-content: center;
    margin-left: -6px; margin-right: -6px; border-radius: 4px; padding: 4px; touch-action: none;
  }
  .drag-handle:active { cursor: grabbing; }
  .drag-handle svg { width: 18px; height: 18px; fill: #9aa0a6; }
  .icon-btn {
    background: transparent; border: none; padding: 4px; cursor: pointer;
    display: flex; align-items: center; justify-content: center; border-radius: 4px;
    transition: transform 0.2s;
  }
  .icon-btn:hover { background: rgba(255,255,255,0.1); }
  .icon-btn svg { width: 18px; height: 18px; fill: #9aa0a6; }
  .brand { display: flex; align-items: center; gap: calc(8px * var(--s)); }
  .logo { width: var(--logo, 22px); height: var(--logo, 22px); flex: none; display: block; }
  .name { font-weight: 600; color: #bdc1c6; white-space: nowrap; }
  .stages { display: flex; gap: calc(6px * var(--s)); }
  .dot {
    position: relative; width: calc(30px * var(--s)); height: calc(30px * var(--s)); border-radius: 50%;
    display: grid; place-items: center; font-size: calc(11px * var(--s)); font-weight: 700;
    border: 1.5px solid #5f6368; color: #9aa0a6; background: transparent; cursor: default;
    transition: background-color .25s, border-color .25s, color .25s;
  }
  .dot[data-status="partial"] { background: #fdd663; border-color: #fdd663; color: #202124; }
  .dot[data-status="complete"] { background: #81c995; border-color: #81c995; color: #202124; }
  .dot:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
  .tip {
    display: none; position: fixed; z-index: 1;
    width: 260px; padding: 10px 12px; border-radius: 8px;
    background: #303134; border: 1px solid #5f6368; color: #e8eaed;
    font: 400 12px/1.4 "Google Sans", Roboto, Arial, sans-serif; text-align: left;
  }
  .tip.show { display: block; }
  .tip b { display: block; font-size: 13px; margin-bottom: 2px; }
  .tip .st { color: #bdc1c6; margin-bottom: 6px; }
  .tip .crit { color: #9aa0a6; margin-top: 6px; }
  .insight { flex: 1; min-width: 180px; color: #e8eaed; }
  .insight.quiet { color: #9aa0a6; }
  .insight.fresh { animation: pulse 1.2s ease-out 1; }
  @keyframes pulse { from { color: #8ab4f8; } to { color: #e8eaed; } }
  button {
    font: inherit; font-weight: 600; border-radius: 999px; padding: 7px 14px; cursor: pointer; white-space: nowrap;
    border: 1px solid #5f6368; background: transparent; color: #8ab4f8; flex-shrink: 0;
  }
  button.primary { background: #8ab4f8; border-color: #8ab4f8; color: #202124; }
  button.end { color: #f28b82; border-color: #f28b82; }
  button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
  .meta { color: #9aa0a6; font-size: calc(11px * var(--s)); white-space: nowrap; }
  .hidden { display: none !important; }
  .rz { position: absolute; z-index: 2; touch-action: none; }
  .rz-top { top: 0; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
  .rz-right { top: 12px; right: 0; bottom: 12px; width: 6px; cursor: ew-resize; }
  .rz-corner { top: 0; right: 0; width: 16px; height: 16px; cursor: nesw-resize; }
  .rz-corner::after {
    content: ""; position: absolute; top: 4px; right: 4px; width: 7px; height: 7px;
    border-top: 2px solid #5f6368; border-right: 2px solid #5f6368; border-top-right-radius: 3px;
  }
  .bar:hover .rz-corner::after { border-color: #9aa0a6; }
  @media (prefers-reduced-motion: reduce) { .dot, .insight.fresh { transition: none; animation: none; } }
  `;

  function createPanel({ onStart, onEnd, onCrm }) {
    const host = document.createElement('div');
    host.id = 'calltrack-copilot-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="bar" role="region" aria-label="CallTrack Copilot">
        <div class="drag-handle" title="Mover painel">
          <svg viewBox="0 0 24 24"><path d="M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H7l5 5 5-5h-3v-3z"/></svg>
        </div>
        <span class="brand">
          <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="1" y="2" width="22" height="20" rx="5.5" fill="#fff"/>
            <path d="M0 12H6.6L10.4 3.9Q10.9 2.9 11.4 3.9L15.1 18.3Q15.5 19.3 16 18.3L18.2 12H24" fill="none" stroke="#202124" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span class="name">CallTrack</span>
        </span>
        <button class="icon-btn toggle-collapse" title="Minimizar/Expandir">
          <svg viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
        </button>
        <button class="icon-btn open-crm" title="Abrir CRM do CallTrack">
          <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/><path d="M7 12h2v5H7zm4-3h2v8h-2zm4-3h2v11h-2z"/></svg>
        </button>
        <div class="stages hidden" role="list"></div>
        <div class="insight quiet" aria-live="polite">Analisar esta call?</div>
        <span class="meta hidden"></span>
        <button class="primary start">Analisar call</button>
        <button class="end hidden">Encerrar call</button>
        <div class="rz rz-top" data-rz="n" title="Arraste para mudar a altura"></div>
        <div class="rz rz-right" data-rz="e" title="Arraste para mudar a largura"></div>
        <div class="rz rz-corner" data-rz="ne" title="Arraste para redimensionar · duplo clique volta ao tamanho padrão"></div>
      </div>
      <div class="tip" role="tooltip"><b></b><div class="st"></div><div class="why"></div><div class="crit"></div></div>`;
    document.documentElement.appendChild(host);

    const $ = (s) => shadow.querySelector(s);
    const bar = $('.bar');
    const stagesEl = $('.stages');
    const insight = $('.insight');
    const meta = $('.meta');
    const startBtn = $('.start');
    const endBtn = $('.end');
    const tip = $('.tip');
    let playbookStages = [];
    const stageInfo = new Map(); // key -> { label, criteria, status, reason }

    startBtn.addEventListener('click', () => onStart());
    endBtn.addEventListener('click', () => onEnd());
    $('.open-crm').addEventListener('click', () => { if (onCrm) onCrm(); });

    let collapsed = false;
    $('.toggle-collapse').addEventListener('click', () => {
      collapsed = !collapsed;
      bar.classList.toggle('collapsed', collapsed);
      $('.toggle-collapse svg').style.transform = collapsed ? 'rotate(180deg)' : '';
      clampIntoView();
    });

    // ─── Layout: posição (left/bottom) e tamanho (width/height) ────────────────
    // left/bottom ancoram o canto inferior esquerdo; redimensionar pelo topo cresce para cima.
    const layout = { left: 16, bottom: 88, width: null, height: null };

    function applyLayout() {
      bar.style.left = `${layout.left}px`;
      bar.style.bottom = `${layout.bottom}px`;
      bar.style.width = layout.width ? `${layout.width}px` : '';
      bar.style.height = layout.height ? `${layout.height}px` : '';
      bar.classList.toggle('sized', !!(layout.width || layout.height));
      updateScale();
    }

    // Conteúdo acompanha o tamanho: acima de TALL_H a sugestão vai para a linha de baixo
    // e bolinhas/textos crescem proporcionalmente à altura (até 1,6x).
    // O logo cresce com a altura e também com a largura, sem passar da altura disponível.
    function updateScale() {
      const h = collapsed ? 0 : (layout.height || 0);
      const w = collapsed ? 0 : (layout.width || 0);
      const tall = h >= TALL_H;
      bar.classList.toggle('tall', tall);
      const s = tall ? Math.min(1.6, Math.max(1, 1 + (h - TALL_H) / 220)) : 1;
      bar.style.setProperty('--s', s.toFixed(3));
      const byWidth = w ? Math.min(1.6, Math.max(1, 1 + (w - 960) / 900)) : 1;
      let logo = 22 * Math.max(s, byWidth);
      if (h && !tall) logo = Math.min(logo, h - 22);
      bar.style.setProperty('--logo', `${Math.max(22, Math.round(logo))}px`);
    }

    function clampIntoView() {
      const r = bar.getBoundingClientRect();
      const maxLeft = Math.max(MARGIN, window.innerWidth - r.width - MARGIN);
      const maxBottom = Math.max(MARGIN, window.innerHeight - r.height - MARGIN);
      layout.left = Math.min(Math.max(MARGIN, layout.left), maxLeft);
      layout.bottom = Math.min(Math.max(MARGIN, layout.bottom), maxBottom);
      if (layout.width) layout.width = Math.min(layout.width, window.innerWidth - layout.left - MARGIN);
      if (layout.height) layout.height = Math.min(layout.height, window.innerHeight - layout.bottom - MARGIN);
      applyLayout();
    }

    function saveLayout() {
      try { chrome.storage?.local?.set({ [STORE_KEY]: layout }); } catch { /* contexto da extensão invalidado */ }
    }

    try {
      chrome.storage?.local?.get(STORE_KEY).then((v) => {
        const saved = v?.[STORE_KEY];
        if (saved && typeof saved === 'object') {
          for (const k of Object.keys(layout)) if (typeof saved[k] === 'number' || saved[k] === null) layout[k] = saved[k];
          clampIntoView();
        }
      }).catch(() => {});
    } catch { /* sem chrome.storage (ex.: teste) */ }

    applyLayout();
    window.addEventListener('resize', clampIntoView);

    // Arrastar e redimensionar com pointer events (mouse, caneta e toque).
    function track(el, onMove) {
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        const r = bar.getBoundingClientRect();
        const start = { x: e.clientX, y: e.clientY, left: r.left, bottom: window.innerHeight - r.bottom, width: r.width, height: r.height };
        const move = (ev) => { onMove(ev.clientX - start.x, ev.clientY - start.y, start); applyLayout(); };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          clampIntoView();
          saveLayout();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    }

    track($('.drag-handle'), (dx, dy, s) => {
      layout.left = s.left + dx;
      layout.bottom = s.bottom - dy;
    });

    for (const el of shadow.querySelectorAll('[data-rz]')) {
      const dir = el.dataset.rz;
      track(el, (dx, dy, s) => {
        if (dir.includes('e')) {
          layout.width = Math.round(Math.min(Math.max(MIN_W, s.width + dx), window.innerWidth - s.left - MARGIN));
        }
        if (dir.includes('n')) {
          layout.height = Math.round(Math.min(Math.max(MIN_H, s.height - dy), window.innerHeight - s.bottom - MARGIN));
        }
      });
    }

    $('.rz-corner').addEventListener('dblclick', () => {
      layout.width = null;
      layout.height = null;
      clampIntoView();
      saveLayout();
    });

    // ─── Dica das etapas (fica fora da barra para não ser cortada pelo overflow) ─
    function showTip(dot) {
      const info = stageInfo.get(dot.dataset.key);
      if (!info) return;
      tip.querySelector('b').textContent = info.label;
      tip.querySelector('.st').textContent = info.status;
      tip.querySelector('.why').textContent = info.reason;
      tip.querySelector('.crit').textContent = `Completo quando: ${info.criteria}`;
      tip.classList.add('show');
      const r = dot.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - MARGIN);
      const top = r.top - t.height - 10 >= MARGIN ? r.top - t.height - 10 : r.bottom + 10;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }
    const hideTip = () => tip.classList.remove('show');
    stagesEl.addEventListener('mouseover', (e) => { const d = e.target.closest('.dot'); if (d) showTip(d); });
    stagesEl.addEventListener('mouseout', (e) => { if (!stagesEl.contains(e.relatedTarget)) hideTip(); });
    stagesEl.addEventListener('focusin', (e) => { const d = e.target.closest('.dot'); if (d) showTip(d); });
    stagesEl.addEventListener('focusout', hideTip);

    function setInsight(text, quiet) {
      insight.textContent = text;
      insight.classList.toggle('quiet', !!quiet);
      insight.classList.remove('fresh');
      if (!quiet) { void insight.offsetWidth; insight.classList.add('fresh'); }
    }

    return {
      // O nome na barra é sempre "CallTrack"; a metodologia (ex.: SPICED) aparece só na dica.
      setPlaybook(name, stages) {
        playbookStages = stages;
        $('.brand').title = `CallTrack · metodologia ${name}`;
        stagesEl.innerHTML = '';
        stageInfo.clear();
        for (const st of stages) {
          const d = document.createElement('div');
          d.className = 'dot';
          d.dataset.key = st.key;
          d.dataset.status = 'none';
          d.tabIndex = 0;
          d.setAttribute('role', 'listitem');
          d.textContent = st.key;
          stageInfo.set(st.key, { label: st.label, criteria: st.complete_criteria, status: STATUS_LABEL.none, reason: '' });
          stagesEl.appendChild(d);
        }
        this.setStages({});
      },
      setStages(stages) {
        for (const st of playbookStages) {
          const d = stagesEl.querySelector(`[data-key="${st.key}"]`);
          const s = stages[st.key] ?? { status: 'none' };
          d.dataset.status = s.status;
          const c = s.counts ? ` · ${s.counts.seller} vendedor · ${s.counts.lead} lead` : '';
          const info = stageInfo.get(st.key);
          info.status = `${STATUS_LABEL[s.status] ?? s.status}${c}`;
          info.reason = s.reason || '';
          d.setAttribute('aria-label', `${st.label}: ${STATUS_LABEL[s.status] ?? s.status}`);
        }
      },
      setSuggestion(s) {
        if (s?.text) setInsight(s.text, false);
      },
      setState(state, message) {
        const live = state === 'live';
        stagesEl.classList.toggle('hidden', !(live || state === 'ended'));
        startBtn.classList.toggle('hidden', !(state === 'idle' || state === 'error'));
        endBtn.classList.toggle('hidden', !live);
        meta.classList.toggle('hidden', !live);
        if (state === 'idle') setInsight(message || 'Analisar esta call?', true);
        if (state === 'connecting') setInsight('Conectando…', true);
        if (state === 'live' && message) setInsight(message, true);
        if (state === 'ended') setInsight(message || 'Call encerrada. O relatório fica pronto em alguns minutos.', true);
        if (state === 'error') { setInsight(message, false); startBtn.textContent = 'Tentar de novo'; }
      },
      setMeta(text) { meta.textContent = text; },
      destroy() { window.removeEventListener('resize', clampIntoView); host.remove(); },
    };
  }

  root.CallTrackPanel = { createPanel };
})(self);
