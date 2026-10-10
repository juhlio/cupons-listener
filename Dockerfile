FROM node:20-alpine

WORKDIR /app

# Instala só as dependências primeiro (cache de build). package-lock commitado
# garante build reprodutível.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Volumes persistentes: sessão do Baileys e estado (dedup).
RUN mkdir -p /app/auth_state /app/data
ENV AUTH_DIR=/app/auth_state \
    DATA_DIR=/app/data \
    PORT=3334 \
    NODE_ENV=production
EXPOSE 3334

CMD ["node", "src/index.js"]
