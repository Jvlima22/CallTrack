// Playbook SPICED padrão (seção 4 da especificação).
// Critical Event é uma etapa só ("CE"), como no sistema da G4.
export const STAGE_ORDER = ['S', 'P', 'I', 'CE', 'D'];

export const DEFAULT_SPICED = {
  id: 'spiced-default',
  name: 'SPICED',
  version: 1,
  product: null,
  language: 'pt-BR',
  stages: [
    {
      key: 'S', label: 'Situation', order: 1, weight: 1.0, evidence_rule: 'lead_required',
      complete_criteria: 'Lead confirmou o contexto operacional: processo atual, ferramentas, tamanho do time e volume.',
      partial_criteria: 'Parte do contexto veio só do vendedor ou de pesquisa, sem confirmação do lead.',
      suggested_questions: ['Como funciona hoje o processo de vocês?', 'Quem está envolvido nisso no dia a dia?'],
    },
    {
      key: 'P', label: 'Pain', order: 2, weight: 1.0, evidence_rule: 'lead_required',
      complete_criteria: 'Lead descreveu o problema com as próprias palavras e a causa raiz ficou clara.',
      partial_criteria: 'Sintoma citado, sem causa raiz.',
      suggested_questions: ['O que você acha que está por trás disso?', 'Desde quando isso acontece?'],
    },
    {
      key: 'I', label: 'Impact', order: 3, weight: 1.0, evidence_rule: 'lead_required',
      complete_criteria: 'Lead quantificou o impacto em dinheiro, tempo ou risco, ou disse o impacto pessoal.',
      partial_criteria: 'Impacto qualitativo, sem número.',
      suggested_questions: ['Quanto isso custa por mês hoje?', 'O que acontece se isso não for resolvido?'],
    },
    {
      key: 'CE', label: 'Critical Event', order: 4, weight: 1.0, evidence_rule: 'lead_required',
      complete_criteria: 'Lead confirmou uma data limite fixa E uma consequência de negócio ligada a perder essa data.',
      partial_criteria: 'Apenas data desejada, ou consequência sem data.',
      suggested_questions: ['O que acontece se isso não estiver resolvido até essa data?'],
    },
    {
      key: 'D', label: 'Decision', order: 5, weight: 1.0, evidence_rule: 'lead_required',
      complete_criteria: 'Critérios de decisão E processo de decisão (quem aprova, ordem, orçamento) conhecidos.',
      partial_criteria: 'Só critérios ou só processo.',
      suggested_questions: ['Quem mais precisa aprovar?', 'Como vocês decidem entre as opções?'],
    },
  ],
  extra_signals: ['objection', 'overpromise', 'case_request'],
};

export function emptyStages() {
  return Object.fromEntries(STAGE_ORDER.map((k) => [k, { status: 'none', reason: '', evidence_turn_ids: [] }]));
}
