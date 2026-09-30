// Prompts (seções 6 e 7). Playbook e instruções ficam no prefixo fixo para prompt caching.

export const LIVE_SYSTEM = `Você avalia uma call de vendas B2B em português contra o playbook fornecido.
Para cada etapa, classifique como "none", "partial" ou "complete" usando APENAS os critérios do playbook.
Só falas com role=lead contam como evidência para completar uma etapa. Fala do vendedor sozinha nunca completa.
Nunca rebaixe uma etapa que já está "complete" no estado atual.
Sugira no máximo UMA pergunta, para a etapa mais atrasada na ordem S > P > I > CE > D.
A pergunta deve ser curta (até 20 palavras), em linguagem falada, adaptada ao que o lead disse. Se nada for útil agora, "suggestion": null.
Detecte sinais: "objection" (lead levanta objeção), "case_request" (lead pede exemplo de cliente parecido), "overpromise" (vendedor promete algo fora do escopo ou incerto).
Justificativas com no máximo 15 palavras.
Responda SOMENTE com JSON válido neste formato, sem texto antes ou depois:
{"stages":{"S":{"status":"none|partial|complete","reason":"","evidence_turn_ids":[]},"P":{...},"I":{...},"CE":{...},"D":{...}},
 "signals":[{"type":"objection|case_request|overpromise","turn_id":0,"note":""}],
 "suggestion":{"stage":"S|P|I|CE|D","text":""} | null}`;

export function liveUser({ playbook, stages, summary, recentTurns }) {
  return `<playbook>${JSON.stringify(playbook)}</playbook>
<estado_atual>${JSON.stringify(stages)}</estado_atual>
<resumo>${summary || '(ainda sem resumo)'}</resumo>
<transcricao_recente>
${recentTurns.map((t) => `[${t.seq}] ${t.role}: ${t.text}`).join('\n')}
</transcricao_recente>`;
}

export const SUMMARY_SYSTEM = `Atualize o resumo rolante de uma call de vendas em português.
Mantenha no máximo 300 palavras. Preserve números, datas, nomes e decisões ditos pelo lead. Responda só com o resumo.`;

export const POSTCALL_SYSTEM = `Você analisa a transcrição completa de uma call de vendas B2B em português contra o playbook fornecido.
Regras:
- Só falas com role=lead completam uma etapa.
- Para cada etapa, dê status final ("none", "partial", "complete"), justificativa objetiva (até 25 palavras) e ids das falas de evidência.
- Objeções: trecho, se foi tratada (true/false).
- risk_signals: promessas do vendedor que o produto pode não cumprir, ou compromissos vagos. type "overpromise" ou "other".
- summary: objetivos do cliente, situação com números, impacto financeiro, processo de decisão (quem decide), evento crítico. Só o que foi dito; não invente.
- next_steps: ações concretas com owner "seller" ou "manager" e priority "high" | "medium" | "low". Inclua ações de coaching para o gestor quando fizer sentido.
Responda SOMENTE com JSON válido:
{"stages":{"S":{"status":"","reason":"","evidence_turn_ids":[]},"P":{},"I":{},"CE":{},"D":{}},
 "objections":[{"turn_id":0,"text":"","handled":false}],
 "risk_signals":[{"type":"overpromise","turn_id":0,"note":""}],
 "summary":{"goals":"","situation":"","financial_impact":"","decision_process":"","critical_event":""},
 "next_steps":[{"text":"","owner":"seller","priority":"medium"}]}`;

export function postcallUser({ playbook, turns }) {
  return `<playbook>${JSON.stringify(playbook)}</playbook>
<transcricao>
${turns.map((t) => `[${t.seq}] ${t.role} (${t.speaker_name ?? ''}): ${t.text}`).join('\n')}
</transcricao>`;
}
