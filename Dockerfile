FROM node:22-alpine

# Adicione esta linha para instalar ferramentas básicas de compilação
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Dependências primeiro (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Código
COPY index.js secrets-reader.js ./

EXPOSE 3000

# Health check nativo do Docker — Portainer exibe o status automaticamente
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Usuário não-root
USER node

CMD ["node", "index.js"]


