<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo-light.png" alt="CallTrack" width="320">
  </picture>
</p>

# CallTrack

Registro e histórico de chamadas para atendimento 24h — grava a ligação, registra o chamado com relatório e permite reouvir a gravação.

Arquivo único (`calltrack.html`), sem instalação e sem conexão externa: tudo fica salvo localmente no navegador (IndexedDB).

## Como usar

1. Abra `calltrack.html` no Chrome ou Edge.
2. Na engrenagem, informe seu nome e a fonte de áudio:
   - **Somente microfone** — ligação em outro aparelho ou áudio saindo na caixa de som.
   - **Microfone + áudio do computador** — softphone no PC; ao iniciar a chamada, marque "Compartilhar áudio do sistema".
3. `F2` inicia a chamada, `F4` marca um momento, `F9` finaliza e registra.

## Funcionalidades

- Gravação da chamada com pausa (música de espera) e medidor de nível
- Formulário com categoria/tipo de ocorrência e checklist específico por tipo
- Marcadores de tempo durante a chamada, que viram a linha do tempo do relatório
- Aviso de atendimentos anteriores do mesmo telefone ou placa/apólice
- Relatório gerado automaticamente, com botão para copiar
- Player com forma de onda: clique para pular, ±10 s, velocidade 0,75x–2x, marcadores clicáveis
- Busca (sem acentos) e filtros por período, categoria e status
- Indicadores do dia: chamadas, TMA, resolvidos e em aberto
- Tema claro/escuro

## Atalhos

| Tecla | Ação |
|---|---|
| `F2` | Iniciar chamada |
| `F4` | Marcar momento |
| `F9` | Finalizar chamada |
| `Espaço` | Tocar/pausar gravação |
| `J` / `L` | Voltar/avançar 10 s |
| `/` | Buscar |

## Observações

- Os dados ficam só no navegador deste computador; limpar os dados do navegador apaga os chamados.
- Confirme com a empresa a política de gravação antes de usar em ligações reais.
