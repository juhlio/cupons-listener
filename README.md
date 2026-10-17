# cupons-listener

Serviço que lê o **canal oficial do WhatsApp** "Afiliados e Criadores Mercado
Livre" e repassa cada mensagem ao [ml-ofertas-service](https://github.com/juhlio/ml-ofertas-service)
(`POST /webhook/cupons`), que extrai e guarda os cupons.

Existe porque o ML **não tem API de cupons** para afiliados e a Evolution API
**não ingere mensagens de canal** (`@newsletter`). A leitura é feita com
[Baileys](https://github.com/WhiskeySockets/Baileys) (WhatsApp Web), como um
**dispositivo vinculado adicional** de um **número dedicado** que já segue o canal.

## Somente leitura (passivo)

Nunca envia mensagem, não marca como lido, não altera presença
(`markOnlineOnConnect: false`) e **não segue/deixa de seguir** nada — o número já
segue o canal. Isso minimiza o risco de ban.

## Como captura

1. No connect, resolve o JID do canal via `newsletterMetadata('invite', CHANNEL_INVITE_CODE)`.
2. **Backfill** no 1º start: últimas ~50 mensagens.
3. **Primário:** polling `newsletterFetchMessages` a cada `POLL_MINUTES`.
4. **Secundário:** `subscribeNewsletterUpdates` + `messages.upsert` (tempo real).
5. Dedup por `msg_id`; encaminha `{ msg_id, timestamp, texto }` com retry/backoff.
   Se o envio falhar, a mensagem **não** é marcada como vista (o polling tenta de novo).

## Variáveis (.env)

| Var | Para quê |
|---|---|
| `PORT` | porta HTTP (default 3334) |
| `API_KEY` | protege `/qr`; mesmo valor do ml-ofertas-service |
| `CHANNEL_INVITE_CODE` | código após `whatsapp.com/channel/` |
| `ML_OFERTAS_URL` | URL do ml-ofertas-service (sem barra final) |
| `POLL_MINUTES` | intervalo do polling (default 15) |
| `ALERT_WEBHOOK_URL` | (opcional) alertas de desconexão/silêncio |
| `TG_API_ID` / `TG_API_HASH` | credenciais de app do Telegram (my.telegram.org) |
| `TG_SESSION` | sessão da conta dedicada do Telegram (gerada por `scripts/tg-login.js`) |
| `TG_CHANNEL` | `+hash` do convite privado, ou `@username` se o canal for público |
| `LOG_LEVEL` | nível do pino (default info) |

O Telegram é **opcional**: sem `TG_SESSION` ele fica desligado e só o WhatsApp roda.

## Endpoints

- `GET /health` — status da conexão, JID do canal, último poll, última mensagem.
- `GET /qr?key=API_KEY` — enquanto não há sessão, devolve o **QR (PNG)** para parear;
  depois de conectado, responde `já conectado`. O QR também é logado em texto.

## Deploy (Easypanel)

1. App a partir deste repositório (build pelo `Dockerfile`).
2. Variáveis de ambiente (acima).
3. **Volume** em `/app/auth_state` (sessão) — sem ele, perde o pareamento a cada deploy.
   Opcionalmente um volume em `/app/data` (dedup).
4. Domínio para acessar `/qr` e `/health`.

## Telegram (redundância)

Além do WhatsApp, o serviço lê o mesmo canal no Telegram via MTProto (GramJS), com
uma conta dedicada que já está dentro do canal. Só lê, nunca envia.

1. Crie credenciais em https://my.telegram.org (API development tools).
2. Gere a sessão **uma vez**, na sua máquina:
   `TG_API_ID=... TG_API_HASH=... node scripts/tg-login.js`
3. Cole `TG_API_ID`, `TG_API_HASH`, `TG_SESSION` e `TG_CHANNEL` no Easypanel.
4. O `/health` passa a mostrar o bloco `telegram`.

Dedup entre os dois canais, independente de quem trouxe primeiro:
1. `msg_id` da fonte (prefixo `tg:` no Telegram);
2. impressão digital do texto (sem caixa, acento, emoji e URLs);
3. código do cupom (`CÓDIGO 👉 NN% OFF`): a mensagem só é ignorada se **todos** os
   códigos dela já foram enviados. Um código novo na mesma mensagem faz ela passar.

O ml-ofertas também guarda um cupom por código, então mesmo um reenvio chegaria
uma vez só no grupo.

Alertas (`ALERT_WEBHOOK_URL`): um estado por canal. Cada alerta traz o campo `canal`
(`WhatsApp` ou `Telegram`) e avisa uma vez por evento: desconectado há mais de 30 min,
ou 24h sem mensagem nova do canal. O `/health` mostra o bloco `telegram`, com
`connected`, `lastPollAt` e `lastMessageAt`.

## Parear (1ª vez)

1. Abra `https://SEU-LISTENER/qr?key=API_KEY` no navegador.
2. No celular do **número dedicado**: WhatsApp → **Dispositivos conectados** →
   **Conectar um dispositivo** → escaneie o QR.
3. O `/health` deve passar a mostrar `connected: true` e o `channelJid`.

## Re-parear

Se o `/health` mostrar `needsPair: true` (sessão revogada) ou o login for perdido,
o serviço limpa a sessão e volta a servir o QR — basta repetir o passo acima. Para
forçar, apague o volume `/app/auth_state` e reinicie.

## Status das fontes (atualizado em 17/10/2026)

- **Telegram: fonte principal.** Lê o canal pela conta dedicada (MTProto), em tempo real e com catch-up a cada `POLL_MINUTES`.
- **WhatsApp: fora do ar para a captura de texto.** A conexão e a leitura do canal (`newsletterMetadata`) funcionam, mas a consulta de mensagens (`newsletterFetchMessages`) não recebe resposta do servidor: dá `Timed Out` em 60 s. O mesmo acontece com um pareamento novo, então não é a sessão. Não há consulta alternativa no Baileys 6.7.24 nem na RC 7.0. As notificações ao vivo do canal chegam sem texto (tag `live_updates`).
  - O último cupom entregue pelo WhatsApp foi em 16/10 às 19:11 BRT. Não dá para afirmar se a falha começou nesse dia.
  - Cada poll registra `whatsapp: poll ok` (com `n` e `ms`) ou `polling falhou`, para acompanhar se isso muda.
  - O alerta de silêncio do WhatsApp está desligado (`checarAlertas(..., { silencio: false })`), porque não há ação possível enquanto a fonte estiver bloqueada. O alerta de desconexão continua ativo.

## Riscos

- **Lib não oficial** (Baileys) — versão **fixada** (`@whiskeysockets/baileys@6.7.24`),
  `package-lock` commitado, `npm audit` limpo. **Nunca** usar forks "enhanced/newsletter"
  (há forks maliciosos que roubam a sessão).
- **Ban** (baixo, leitura passiva): se ocorrer, afeta o número dedicado — por isso
  **não** é o número principal.
- **Suporte a canal no Baileys** é menos maduro que grupos; por isso o polling é o
  mecanismo primário.
