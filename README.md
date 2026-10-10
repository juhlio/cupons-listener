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
| `LOG_LEVEL` | nível do pino (default info) |

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

## Parear (1ª vez)

1. Abra `https://SEU-LISTENER/qr?key=API_KEY` no navegador.
2. No celular do **número dedicado**: WhatsApp → **Dispositivos conectados** →
   **Conectar um dispositivo** → escaneie o QR.
3. O `/health` deve passar a mostrar `connected: true` e o `channelJid`.

## Re-parear

Se o `/health` mostrar `needsPair: true` (sessão revogada) ou o login for perdido,
o serviço limpa a sessão e volta a servir o QR — basta repetir o passo acima. Para
forçar, apague o volume `/app/auth_state` e reinicie.

## Riscos

- **Lib não oficial** (Baileys) — versão **fixada** (`@whiskeysockets/baileys@6.7.24`),
  `package-lock` commitado, `npm audit` limpo. **Nunca** usar forks "enhanced/newsletter"
  (há forks maliciosos que roubam a sessão).
- **Ban** (baixo, leitura passiva): se ocorrer, afeta o número dedicado — por isso
  **não** é o número principal.
- **Suporte a canal no Baileys** é menos maduro que grupos; por isso o polling é o
  mecanismo primário.
