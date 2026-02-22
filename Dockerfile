FROM node:20-alpine

# Define o diretório de trabalho
WORKDIR /app

# Copia arquivos de dependências primeiro (aproveita cache de camadas)
COPY package*.json ./

# Instala apenas o necessário para produção
RUN npm install --production

# Copia o restante dos arquivos (certifique-se de ter um .dockerignore)
COPY . .

# Usa um usuário não-root por segurança
USER node

# Variáveis de ambiente padrão (podem ser sobrescritas no run)
ENV NODE_ENV=production

# O comando para rodar o MCP
CMD ["node", "index.js"]