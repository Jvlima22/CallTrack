// Métricas da call calculadas sem LLM (seção 7).
// turns: [{ seq, role: 'seller'|'lead'|'internal', text, started_ms, ended_ms }]

const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);

export function computeMetrics(turns) {
  const sorted = [...turns].sort((a, b) => a.seq - b.seq);
  let sellerWords = 0;
  let totalWords = 0;
  let turnCount = 0;
  let questions = 0;
  const longest = { seller: 0, lead: 0 };

  let runRole = null;
  let runStart = 0;
  let runEnd = 0;
  const closeRun = () => {
    if (runRole === 'seller' || runRole === 'lead') {
      longest[runRole] = Math.max(longest[runRole], runEnd - runStart);
    }
  };

  for (const t of sorted) {
    const w = words(t.text);
    totalWords += w;
    if (t.role === 'seller') {
      sellerWords += w;
      questions += (t.text.match(/\?/g) || []).length;
    }
    // internos da mesma empresa contam como lado do vendedor na troca de turnos
    const side = t.role === 'lead' ? 'lead' : 'seller';
    if (side !== runRole) {
      closeRun();
      if (runRole !== null) turnCount += 1;
      runRole = side;
      runStart = t.started_ms;
    }
    runEnd = t.ended_ms;
  }
  closeRun();

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    seller_talk_pct: totalWords ? +((sellerWords / totalWords) * 100).toFixed(2) : 0,
    longest_monologue_s: Math.round(longest.seller / 1000),
    longest_lead_monologue_s: Math.round(longest.lead / 1000),
    turn_count: turnCount,
    question_count: questions,
    duration_s: first ? Math.round((last.ended_ms - first.started_ms) / 1000) : 0,
    talk_in_target: totalWords ? sellerWords / totalWords >= 0.4 && sellerWords / totalWords <= 0.6 : false,
  };
}

// Nota 0–10: completo = 1, parcial = 0,5, ponderado pelo playbook; penalidades simples.
export function computeScore(stages, playbook, metrics, riskSignals = []) {
  const totalWeight = playbook.stages.reduce((s, st) => s + (st.weight ?? 1), 0);
  let points = 0;
  for (const st of playbook.stages) {
    const status = stages[st.key]?.status;
    const v = status === 'complete' ? 1 : status === 'partial' ? 0.5 : 0;
    points += v * (st.weight ?? 1);
  }
  let score = (points / totalWeight) * 10;
  if (metrics && metrics.turn_count > 0 && !metrics.talk_in_target) score -= 0.5;
  if (riskSignals.some((r) => r.type === 'overpromise')) score -= 1;
  return Math.max(0, Math.min(10, +score.toFixed(2)));
}
