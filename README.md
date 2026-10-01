<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo-light.png" alt="CallTrack" width="320">
  </picture>
</p>

# CallTrack

Registro e análise de chamadas em dois módulos, na mesma interface (`calltrack.html`):

- **Reuniões · CRM**: calls de venda no Google Meet capturadas pela extensão **CallTrack Copilot**, com as etapas SPICED ao vivo e a análise pós-call feita pelo Claude (nota, resumo, objeções, riscos e próximos passos). Os cards ficam num kanban Em aberto / Fechado / Perdido.
- **Atendimentos**: registro de chamadas para atendimento 24h. Grava a ligação, registra o chamado com relatório e permite reouvir a gravação. Tudo fica salvo localmente no navegador (IndexedDB).

```
calltrack.html  Interface: CRM de reuniões + atendimentos 24h (arquivo único)
backend/        Node.js + Fastify + MongoDB: REST, WebSocket, motor ao vivo, análise pós-call; serve o calltrack.html em /
extension/      Extensão Chrome MV3: lê as legendas do Meet e mostra o painel SPICED
scripts/        Empacotamento da extensão
assets/         Logos
```

---

## 1. Pré-requisitos

| Requisito | Versão mínima |
|-----------|--------------|
| Node.js   | 20 LTS       |
| Chrome ou Edge | 116+    |
| MongoDB Atlas (cluster gratuito M0) | — |
| Chave da API Anthropic | — |

O módulo **Atendimentos** não precisa de nada disso: basta abrir o `calltrack.html` no navegador.

---

## 2. Banco de dados (MongoDB Atlas)

1. Crie um **Free Cluster** (M0) em [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Em **Database Access**, crie um usuário com a role **readWriteAnyDatabase**.
3. Em **Network Access**, adicione o IP da máquina que roda o backend (ou `0.0.0.0/0` só em desenvolvimento). Sem isso a conexão falha com erro de TLS/"server selection".
4. Em **Clusters → Connect → Drivers**, copie a connection string e acrescente o nome do banco:
   ```
   mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/spiced_copilot?retryWrites=true&w=majority
   ```

Os índices e collections são criados pelo Mongoose no primeiro `npm run seed`.

---

## 3. Backend

```bash
cd backend
cp .env.example .env
```

Preencha o `.env`:

```env
PORT=8787
MONGODB_URI=mongodb+srv://...
ANTHROPIC_API_KEY=sk-ant-...
LIVE_MODEL=claude-haiku-4-5-20251001
POSTCALL_MODEL=claude-sonnet-5-5
LIVE_ENABLED=true          # false = só captura + pós-call, sem custo de LLM durante a call
LIVE_PRICE_IN=1
LIVE_PRICE_OUT=5
POSTCALL_PRICE_IN=3
POSTCALL_PRICE_OUT=15
```

Instale, crie o primeiro usuário e suba o servidor:

```bash
npm install
npm run seed -- "Nome da Empresa" "Seu Nome" voce@empresa.com seller
npm run dev
```

O seed imprime o token (`spc_...`) **uma única vez**. Guarde-o: ele serve para a extensão e para entrar no CRM.

Abra **http://localhost:8787**. O backend entrega o `calltrack.html` já apontando para ele mesmo.

Mais usuários:

```bash
npm run seed -- "Nome da Empresa" "Gerente" gerente@empresa.com manager
npm run seed -- "Nome da Empresa" "Admin" admin@empresa.com admin
```

Rodar o seed de novo com o mesmo e-mail gera um novo token e invalida o anterior.

**Quem vê o quê no CRM:** vendedor vê as próprias calls, manager as do seu time, admin todas da conta.

---

## 4. Extensão CallTrack Copilot

1. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione a pasta `extension/`.
3. No ícone da extensão, preencha **Servidor** (`http://localhost:8787`) e **Token do vendedor** (`spc_...`) e salve.

Na call:

1. Entre no Google Meet e **ative as legendas** em **Português** (botão CC ou tecla `C`).
2. No painel do CallTrack (canto inferior esquerdo), clique em **Analisar call**.
3. Ao terminar, clique em **Encerrar call**. A análise pós-call leva cerca de 30 s.
4. O botão do CRM no painel abre o CallTrack já autenticado.

**Sem a `ANTHROPIC_API_KEY` no `.env`, a captura funciona, mas não há etapas SPICED ao vivo, sugestões nem análise pós-call (a call fica como "Análise falhou").**

### Gravação de vídeo

1. Antes de clicar em **Analisar call**, marque **Gravar vídeo** no painel.
2. O painel mostra o aviso de gravação. Clique em **Copiar aviso**, cole no chat do Meet e clique em **Avisei, começar**.
3. O Chrome pede para compartilhar a aba: escolha a aba do Meet (já vem sugerida) e mantenha **Compartilhar áudio da guia** ligado.
4. Enquanto grava, o painel mostra **REC**. O vídeo sobe em pedaços de 10 s; se a internet cair, ele tenta de novo.
5. Seu microfone entra na gravação e respeita o mudo do Meet: com o Meet no mudo, nada do seu microfone é gravado.
6. **Parar de compartilhar** na barra do Chrome encerra só a gravação; a análise continua.

Para gerar o `.zip` da extensão: `node scripts/pack-extension.js` (na raiz).

---

## 5. Interface (`calltrack.html`)

A alternância **Atendimentos / Reuniões · CRM** fica no topo, e o navegador lembra a última escolha.

### Reuniões · CRM

- Kanban **Em aberto / Fechado (won) / Perdido (lost)**. Arraste o card para mudar o resultado; a mudança é gravada no backend.
- Card: lead, empresa, vendedor, duração, nota SPICED (0–10), etapas S·P·I·CE·D, status (ao vivo, processando) e alerta de risco.
- Detalhe da call: dados editáveis (lead, empresa, ID do negócio), métricas (fala do vendedor, perguntas, maior monólogo, custo), resumo, etapas com justificativa, próximos passos, objeções e riscos, linha do tempo ao vivo e transcrição.
- Busca, filtro por vendedor e período. A lista se atualiza sozinha a cada 30 s.
- Se o arquivo for aberto direto do disco (`file://`), o CRM pede o endereço do servidor e o token.
- **Calls gravadas:** player no detalhe da call, com velocidade de 0,75x a 2x e ±10 s. Os eventos aparecem como marcadores na linha do tempo, e a fala atual fica destacada na transcrição. Clicar numa fala, numa pergunta ou citação das etapas ou num evento leva direto àquele momento do vídeo.

### Guarda dos vídeos

- **Guarda para sempre:** os vídeos não são excluídos automaticamente. Cada gravação registra os dois motivos (prova de negociação ou contrato, para exercício regular de direitos, e cumprimento de obrigação legal) e a confirmação do aviso de gravação, com data e hora.
- **Onde ficam:** os arquivos ficam em `backend/storage/recordings/` (ou `RECORDINGS_DIR`), fora do git e fora do banco. No MongoDB ficam só a ficha de cada vídeo (`recordings`) e a auditoria (`recording_audit`); `RECORDINGS_MONGODB_URI` leva essas duas coleções para um banco separado.
- **Pedido de exclusão:** quando uma pessoa gravada pedir a exclusão, um admin abre a call, registra quem pediu e decide entre **Excluir o vídeo** ou **Recusar e manter**, sempre com motivo. Tudo fica na auditoria, junto de cada abertura do vídeo.
- **Backup:** como nada é apagado, perder o disco é perder as provas. Rode com frequência:
  ```bash
  cd backend
  npm run backup:recordings -- "D:\Backup\CallTrack"
  ```
  A cópia é incremental (só vídeos novos) e exporta as fichas e a auditoria em JSON.
- **Espaço:** cerca de 450 MB por hora de vídeo (720p).

### Atendimentos

- Gravação da chamada com pausa (música de espera) e medidor de nível
- Formulário com categoria/tipo de ocorrência e checklist específico por tipo
- Marcadores de tempo durante a chamada, que viram a linha do tempo do relatório
- Aviso de atendimentos anteriores do mesmo telefone ou placa/apólice
- Relatório gerado automaticamente, com botão para copiar
- Player com forma de onda: clique para pular, ±10 s, velocidade 0,75x–2x, marcadores clicáveis
- Busca (sem acentos) e filtros por período, categoria e status
- Indicadores do dia: chamadas, TMA, resolvidos e em aberto

Os dados dos atendimentos ficam só no navegador deste computador: limpar os dados do navegador apaga os chamados. Confirme com a empresa a política de gravação antes de usar em ligações reais.

### Atalhos

| Tecla | Ação |
|---|---|
| `F2` | Iniciar chamada (atendimento) |
| `F4` | Marcar momento |
| `F9` | Finalizar chamada |
| `Espaço` | Tocar/pausar gravação |
| `J` / `L` | Voltar/avançar 10 s |
| `/` | Buscar (no módulo aberto) |

---

## 6. Rotas da API

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET`  | `/` | Interface (`calltrack.html`) |
| `GET`  | `/health` | Liveness check |
| `GET`  | `/config/meet-selectors` | Seletores do DOM do Meet entregues à extensão |
| `GET`  | `/api/crm/calls` | Calls visíveis ao usuário, com análise e nome do vendedor |
| `POST` | `/calls` | Inicia uma call: retorna `call_id`, `seller_name` e `playbook` |
| `POST` | `/calls/:id/end` | Encerra a call e enfileira a análise pós-call |
| `GET`  | `/calls/:id` | Retorna `call`, `turns`, `analysis` e `events` |
| `PATCH`| `/calls/:id` | Atualiza `lead_name`, `lead_company`, `crm_deal_id` e `outcome` |
| `GET`  | `/ws/calls/:id` | WebSocket: a extensão envia falas, participantes e status da captura; recebe a atualização das etapas |
| `GET`  | `/calls/:id/live` | Estado ao vivo: etapas com contexto, saúde da call, participantes e falas novas (`?since=`) |
| `GET`  | `/api/me` | Usuário logado (nome e papel) |
| `POST` | `/calls/:id/recording/start` | Inicia a gravação (exige o aviso de gravação confirmado) |
| `PUT`  | `/calls/:id/recording/chunks/:seq` | Pedaço do vídeo (corpo binário) |
| `POST` | `/calls/:id/recording/finish` | Encerra a gravação e prepara o vídeo |
| `GET`  | `/calls/:id/recording` | Ficha da gravação, link assinado do player (1 h) e auditoria |
| `GET`  | `/recordings/:id/stream` | Vídeo por faixas de bytes, autorizado pelo link assinado |
| `POST` | `/calls/:id/recording/deletion` | Decisão sobre pedido de exclusão (só admin, com motivo) |

Todas as rotas, exceto `/`, `/health` e `/config/meet-selectors`, exigem `Authorization: Bearer <token>`. Só o WebSocket aceita `?token=`, porque o navegador não permite header no handshake; esse valor é mascarado no log.

---

## 7. O que tende a quebrar na primeira call real

- **Seletores das legendas do Meet.** O Google muda as classes sem aviso. Para corrigir, edite `backend/src/selectors.js` e reinicie o backend; a extensão busca os seletores a cada call, então não é preciso republicá-la.
- **Identificação do vendedor.** Quem aparece como "Você"/"You" nas legendas é classificado como `seller`. Se o Meet usar outro rótulo, adicione-o em `selfLabels`, no mesmo arquivo.
- **Idioma.** Os prompts estão em pt-BR. Configure as legendas do Meet em Português.
- **Custo.** Os preços do `.env` são de referência; confira os valores atuais antes de usar `cost_usd` como métrica.

---

## 8. Testes

```bash
cd backend
npm test
```

São 19 testes: rastreador de legendas, métricas, nota, regras do motor ao vivo (saúde da call, contexto por etapa, nomes de participantes), armazenamento dos vídeos e envio dos pedaços pela extensão.

---

## 9. Decisões de arquitetura

| Decisão | Motivo |
|---------|--------|
| Interface em arquivo único (`calltrack.html`) servida pelo backend | Mantém o CallTrack sem build; o mesmo arquivo funciona aberto do disco (atendimentos) ou via servidor (CRM) |
| Análise só começa quando o vendedor clica "Analisar call" | Evita analisar reuniões internas e cria um momento claro de consentimento (LGPD) |
| Token simples (SHA-256 no banco) | Suficiente para a fase 1. A extensão abre o CRM com `#token=`, que não vai ao servidor e é apagado da barra de endereço |
| Fila de análise em memória, com 3 tentativas | Simples na fase 1; trocar por fila persistente antes de rodar mais de um servidor |
| Seletores do Meet no servidor | Corrigir seletores sem publicar nova versão da extensão |
| Vídeo fora do banco, em pasta própria; ficha e auditoria no MongoDB | Banco não foi feito para arquivos de GB: custo, backup e leitura por faixas ficam melhores num armazenamento de arquivos. Trocar o disco por nuvem (R2/S3) é trocar só `storage.js` |
| Vídeo enviado em pedaços de 10 s e remontado com ffmpeg | Aba fechada ou queda de rede perde no máximo 10 s; o ffmpeg dá ao arquivo duração e índice para avançar e voltar |
