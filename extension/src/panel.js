// Painel do SPICED dentro do Meet. Shadow DOM para o CSS do Meet não vazar.
(function (root) {
  const STATUS_LABEL = { none: 'Não abordado', partial: 'Parcial', complete: 'Completo' };

  const CSS = `
  :host { all: initial; }
  .bar {
    position: fixed; left: 16px; bottom: 88px; z-index: 2147483000;
    display: flex; align-items: center; gap: 14px;
    max-width: min(960px, calc(100vw - 32px));
    padding: 10px 12px 10px 14px; border-radius: 12px;
    background: #202124; border: 1px solid #3c4043; color: #e8eaed;
    font: 13px/1.35 "Google Sans", Roboto, Arial, sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,.35);
  }
  .bar.collapsed .stages, .bar.collapsed .insight, .bar.collapsed .meta, .bar.collapsed .start, .bar.collapsed .end {
    display: none !important;
  }
  .drag-handle {
    cursor: grab; display: flex; align-items: center; justify-content: center;
    margin-left: -6px; margin-right: -6px; border-radius: 4px; padding: 4px;
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
  .name { font-weight: 600; color: #bdc1c6; white-space: nowrap; }
  .stages { display: flex; gap: 6px; }
  .dot {
    position: relative; width: 30px; height: 30px; border-radius: 50%;
    display: grid; place-items: center; font-size: 11px; font-weight: 700;
    border: 1.5px solid #5f6368; color: #9aa0a6; background: transparent; cursor: default;
    transition: background-color .25s, border-color .25s, color .25s;
  }
  .dot[data-status="partial"] { background: #fdd663; border-color: #fdd663; color: #202124; }
  .dot[data-status="complete"] { background: #81c995; border-color: #81c995; color: #202124; }
  .dot:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
  .tip {
    display: none; position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%);
    width: 260px; padding: 10px 12px; border-radius: 8px;
    background: #303134; border: 1px solid #5f6368; color: #e8eaed;
    font-weight: 400; font-size: 12px; text-align: left; line-height: 1.4;
  }
  .dot:hover .tip, .dot:focus .tip { display: block; }
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
  .meta { color: #9aa0a6; font-size: 11px; white-space: nowrap; }
  .hidden { display: none !important; }
  @media (prefers-reduced-motion: reduce) { .dot, .insight.fresh { transition: none; animation: none; } }
  `;

  function createPanel({ onStart, onEnd, onCrm }) {
    const host = document.createElement('div');
    host.id = 'spiced-copilot-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="bar" role="region" aria-label="CallTrack Copilot">
        <div class="drag-handle" title="Mover painel">
          <svg viewBox="0 0 24 24"><path d="M10 9h4V6h3l-5-5-5 5h3v3zm-1 1H6V7l-5 5 5 5v-3h3v-4zm14 2l-5-5v3h-3v4h3v3l5-5zm-9 3h-4v3H7l5 5 5-5h-3v-3z"/></svg>
        </div>
        <span class="name">CallTrack</span>
        <button class="icon-btn toggle-collapse" title="Minimizar/Expandir">
          <svg viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>
        </button>
        <button class="icon-btn open-crm" title="Abrir CRM">
          <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/><path d="M7 12h2v5H7zm4-3h2v8h-2zm4-3h2v11h-2z"/></svg>
        </button>
        <div class="stages hidden" role="list"></div>
        <div class="insight quiet" aria-live="polite">Analisar esta call?</div>
        <span class="meta hidden"></span>
        <button class="primary start">Analisar call</button>
        <button class="end hidden">Encerrar call</button>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (s) => shadow.querySelector(s);
    const bar = $('.bar');
    const stagesEl = $('.stages');
    const insight = $('.insight');
    const meta = $('.meta');
    const startBtn = $('.start');
    const endBtn = $('.end');
    let playbookStages = [];

    startBtn.addEventListener('click', () => onStart());
    endBtn.addEventListener('click', () => onEnd());

    // Toggle Collapse
    let collapsed = false;
    $('.toggle-collapse').addEventListener('click', () => {
      collapsed = !collapsed;
      bar.classList.toggle('collapsed', collapsed);
      $('.toggle-collapse svg').style.transform = collapsed ? 'rotate(180deg)' : '';
    });

    // Open CRM
    $('.open-crm').addEventListener('click', () => {
      if (onCrm) onCrm();
    });

    // Drag and Drop Logic
    const dragHandle = $('.drag-handle');
    let isDragging = false;
    let startX, startY, initialLeft, initialBottom;

    dragHandle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = bar.getBoundingClientRect();
      initialLeft = rect.left;
      initialBottom = window.innerHeight - rect.bottom;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      bar.style.left = `${initialLeft + dx}px`;
      bar.style.bottom = `${initialBottom - dy}px`;
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });

    function setInsight(text, quiet) {
      insight.textContent = text;
      insight.classList.toggle('quiet', !!quiet);
      insight.classList.remove('fresh');
      if (!quiet) { void insight.offsetWidth; insight.classList.add('fresh'); }
    }

    return {
      setPlaybook(name, stages) {
        playbookStages = stages;
        $('.name').textContent = name;
        stagesEl.innerHTML = '';
        for (const st of stages) {
          const d = document.createElement('div');
          d.className = 'dot';
          d.dataset.key = st.key;
          d.dataset.status = 'none';
          d.tabIndex = 0;
          d.setAttribute('role', 'listitem');
          d.innerHTML = `<span>${st.key}</span><div class="tip"><b></b><div class="st"></div><div class="why"></div><div class="crit"></div></div>`;
          d.querySelector('b').textContent = st.label;
          d.querySelector('.crit').textContent = `Completo quando: ${st.complete_criteria}`;
          d.setAttribute('aria-label', `${st.label}: ${STATUS_LABEL.none}`);
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
          d.querySelector('.st').textContent = `${STATUS_LABEL[s.status] ?? s.status}${c}`;
          d.querySelector('.why').textContent = s.reason || '';
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
      destroy() { host.remove(); },
    };
  }

  root.SpicedPanel = { createPanel };
})(self);
