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
POSTCALL_MODEL=claude-sonnet-5
LIVE_ENABLED=true          # false = só captura + pós-call, sem custo de LLM durante a call
LIVE_PRICE_IN=1
LIVE_PRICE_OUT=5
POSTCALL_PRICE_IN=3
POSTCALL_PRICE_OUT=15
```

Instale, crie o primeiro admin e suba o servidor:

```bash
npm install
npm run seed -- "Nome da Empresa" "Seu Nome" voce@empresa.com admin
npm run dev
```

O seed imprime um **link para definir a senha** (uso único, vale 7 dias). Abra o link, crie a senha e você já entra no CRM. Se o CRM for aberto por outro endereço (o do túnel, por exemplo), troque só o começo do link e mantenha a parte a partir de `/#senha=`; ou preencha `PUBLIC_URL` no `.env` para o seed já imprimir o endereço certo.

### Qual IA usar

| Provedor | Como ativar | Custo |
|---|---|---|
| **Claude** (padrão) | `ANTHROPIC_API_KEY` com créditos em console.anthropic.com | ~US$ 0,35–0,65 por call de 30 min com a IA ao vivo; ~US$ 0,04 só com a análise pós-call (`LIVE_ENABLED=false`) |
| **Google Gemini** | `GEMINI_API_KEY` do Google AI Studio (aistudio.google.com → Get API key) | Grátis no nível gratuito, com limite de pedidos por minuto |

Sem `LLM_PROVIDER`, o CallTrack usa o Claude se `ANTHROPIC_API_KEY` estiver preenchida, senão o Gemini. Para forçar um deles: `LLM_PROVIDER=gemini` ou `LLM_PROVIDER=anthropic`.

> No nível gratuito do Gemini, o Google pode usar o conteúdo enviado para melhorar os produtos dele. Use para testes (como o roteiro de teste), não para calls reais com clientes; para essas, use um plano pago.

Para conferir a IA configurada (chave, modelos e uma avaliação de verdade com um trecho do roteiro de teste):

```bash
npm run llm:check
```

Abra **http://localhost:8787** (ou o endereço do túnel). O CRM só funciona aberto pelo endereço do servidor: o login fica num cookie daquele endereço. Aberto direto do disco (`file://`), só o módulo Atendimentos funciona.

### Acesso e usuários

- **Entrar:** e-mail e senha. A sessão dura até 30 dias e cai depois de 7 dias sem uso, ou ao clicar em **Sair**.
- **Convidar pessoas:** só admin, no CRM, em **Usuários** → nome, e-mail, papel e time → **Convidar**. O CRM mostra um link de uso único (vale 7 dias) para a pessoa criar a senha. Envie o link só para ela: quem tiver o link define a senha daquela conta.
- **Esqueceu a senha:** o admin clica em **Redefinir senha** na linha da pessoa e envia o link novo. A senha antiga vale até o link ser usado. Não há envio automático de e-mail.
- **Desativar:** a pessoa sai do CRM na hora e os tokens da extensão dela param de funcionar. As calls dela continuam no CRM.
- **Encerrar acessos:** desconecta todos os navegadores e tokens da extensão de alguém, sem desativar.
- **Registro de acessos:** em **Usuários**, a lista mostra logins (inclusive os que falharam), saídas, convites, tokens e mudanças de papel, com data e IP.
- **Proteções:** senha com no mínimo 10 caracteres, guardada com `scrypt`. Depois de 5 senhas erradas para o mesmo e-mail em 15 minutos, o login desse e-mail fica bloqueado por 15 minutos (o contador fica na memória e zera quando o backend reinicia). O cookie é `HttpOnly` e `SameSite=Lax` (e `Secure` em https). Ações que mudam dados só valem se vierem da própria página do CRM.
- **Quem vê o quê no CRM:** vendedor vê as próprias calls; gestor, as do seu time (gestor sem time não vê calls de outras pessoas); admin, todas da conta.
- **Esqueci a senha do único admin:** rode o seed de novo com o mesmo e-mail, no servidor. Ele gera um link novo e não mexe nas calls.

---

## 4. Extensão CallTrack Copilot

1. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione a pasta `extension/`.
3. No CRM, abra **Minha conta** → **Gerar token** (um por computador, com um nome como "Notebook do escritório"). O token aparece uma única vez.
4. No ícone da extensão, preencha **Servidor** (o mesmo endereço do CRM) e **Token deste computador** e salve. A extensão confere o token e mostra para quem ele foi emitido.

Se o computador for perdido ou trocado, revogue só o token dele em **Minha conta**. Tokens criados pelo seed em versões anteriores continuam funcionando e aparecem como "Token antigo (seed)"; revogue-os quando tiver gerado os novos.

Na call:

1. Entre no Google Meet e **ative as legendas** em **Português** (botão CC ou tecla `C`).
2. No painel do CallTrack (canto inferior esquerdo), clique em **Analisar call**.
3. Ao terminar, clique em **Encerrar call**. A análise pós-call leva cerca de 30 s.
4. O botão do CRM no painel abre o CRM. O token da extensão não dá acesso ao CRM: entre com e-mail e senha.

**Sem uma chave de IA no `.env` (`ANTHROPIC_API_KEY` ou `GEMINI_API_KEY`), a captura funciona, mas não há etapas SPICED ao vivo, sugestões nem análise pós-call (a call fica como "Análise falhou").**

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
- **Calls gravadas:** player no detalhe da call, que abre recolhido (só o cabeçalho do card). **Expandir vídeo** mostra o vídeo e os controles, e o navegador lembra a escolha. Recolher pausa o vídeo; clicar num momento da call expande o player. O player tem velocidade de 0,75x a 2x e ±10 s. Os eventos aparecem como marcadores na linha do tempo, e a fala atual fica destacada na transcrição. Clicar numa fala, numa pergunta ou citação das etapas ou num evento leva direto àquele momento do vídeo.

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
| `V` | Expandir/recolher o vídeo da call (CRM) |
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
| `POST` | `/auth/login` | Entrar com `email` e `password`; cria o cookie de sessão |
| `POST` | `/auth/logout` | Sair (encerra a sessão no servidor) |
| `POST` | `/auth/password-link/check` | Confere um link de definir senha (`token`) |
| `POST` | `/auth/password-link` | Define a senha pelo link (`token`, `password`) e entra |
| `POST` | `/auth/password` | Troca a própria senha (`current`, `password`); derruba as outras sessões |
| `POST` | `/auth/sessions/revoke-others` | Sai dos outros dispositivos |
| `GET`  | `/api/me` | Usuário logado (nome, e-mail, papel, time) |
| `GET` `POST` `DELETE` | `/api/me/tokens[/:id]` | Tokens da extensão do próprio usuário (o valor só aparece na criação) |
| `GET`  | `/api/extension/me` | A extensão confere o token |
| `GET` `POST` | `/api/admin/users` | Lista e convida usuários (admin) |
| `PATCH`| `/api/admin/users/:id` | Nome, papel, time, ativo (admin) |
| `POST` | `/api/admin/users/:id/password-link` | Link de convite/redefinição de senha (admin) |
| `POST` | `/api/admin/users/:id/revoke` | Encerra sessões e tokens de alguém (admin) |
| `GET` `POST` | `/api/admin/teams` | Times da conta (admin) |
| `GET`  | `/api/admin/events` | Registro de acessos (admin) |
| `POST` | `/calls/:id/recording/start` | Inicia a gravação (exige o aviso de gravação confirmado) |
| `PUT`  | `/calls/:id/recording/chunks/:seq` | Pedaço do vídeo (corpo binário) |
| `POST` | `/calls/:id/recording/finish` | Encerra a gravação e prepara o vídeo |
| `GET`  | `/calls/:id/recording` | Ficha da gravação, link assinado do player (1 h) e auditoria |
| `GET`  | `/recordings/:id/stream` | Vídeo por faixas de bytes, autorizado pelo link assinado |
| `POST` | `/calls/:id/recording/deletion` | Decisão sobre pedido de exclusão (só admin, com motivo) |

**Acesso:** as rotas do CRM usam a sessão (cookie `ct_session`). As rotas que a extensão chama (`POST /calls`, `GET /calls/:id`, `/calls/:id/end`, o WebSocket e `/calls/:id/recording/start|chunks|finish`) aceitam também `Authorization: Bearer <token da extensão>`; o token não abre as rotas do CRM. Só o WebSocket aceita `?token=`, porque o navegador não permite header no handshake; esse valor é mascarado no log. Ficam abertas só `/`, `/health`, `/config/meet-selectors`, `/auth/login`, os links de senha e o vídeo (autorizado pelo link assinado).

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

São 31 testes: login (senha, cookie, limite de tentativas, origem, expiração da sessão), rastreador de legendas, métricas, nota, regras do motor ao vivo (saúde da call, contexto por etapa, nomes de participantes), armazenamento dos vídeos, envio dos pedaços pela extensão e escolha/chamada do provedor de IA.

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
