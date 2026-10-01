// Seletores do DOM de legendas do Google Meet.
// O Google muda essas classes sem aviso: por isso ficam no servidor e a extensão busca a cada call.
// Ordem de tentativa: seletores estruturais (aria) primeiro, classes ofuscadas por último.
// VALIDAR numa call real antes de usar em produção.
export const MEET_SELECTORS = {
  version: 1,
  // container de legendas
  region: [
    'div[role="region"][aria-label*="Legendas" i]',
    'div[role="region"][aria-label*="Captions" i]',
    'div[jsname="dsyhDe"]',
  ],
  // cada bloco = um falante contínuo
  block: [':scope > div', 'div.nMcdL'],
  // nome do falante dentro do bloco
  speaker: ['.NWpY1d', '.KcIKyf', 'span'],
  // texto dentro do bloco
  text: ['.ygicle', '.bh44bd', 'div:last-child'],
  // botão de legendas na barra (para ligar automaticamente)
  captionsButton: [
    'button[aria-label*="legendas" i]',
    'button[aria-label*="captions" i]',
  ],
  // nome do próprio usuário (fica marcado como "Você"/"You" nas legendas)
  selfLabels: ['Você', 'You'],
  // participantes: cada bloco de vídeo, o nome dentro dele e a foto
  participantTile: ['[data-participant-id]', '[data-requested-participant-id]'],
  participantName: ['[data-self-name]', '.zWGUib', '.XEazBc', '.dwSJ2e', '[jsname="EydYod"]'],
  participantAvatar: ['img[src*="googleusercontent.com"]'],
  // marca do bloco do próprio usuário
  selfTile: ['[data-self-name]'],
  // título da reunião (quando vem do Google Agenda)
  meetingTitle: ['[data-meeting-title]'],
  // botão de microfone do Meet (data-is-muted="true" = no mudo): a gravação respeita o mudo
  micButton: ['button[data-is-muted][aria-label*="microfone" i]', 'button[data-is-muted][aria-label*="microphone" i]'],
};
