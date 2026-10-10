FROM node:20-alpine

WORKDIR /app

# Instala só as dependências primeiro (cache de build). package-lock commitado
# garante build reprodutível.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Volumes persistentes: sessão do Baileys e estado (dedup). Pertencem ao usuário
# não-root `node` (presente na imagem), que é quem roda o processo.
RUN mkdir -p /app/auth_state /app/data && chown -R node:node /app
ENV AUTH_DIR=/app/auth_state \
    DATA_DIR=/app/data \
    PORT=3334 \
    NODE_ENV=production
EXPOSE 3334

USER node
CMD ["node", "src/index.js"]
