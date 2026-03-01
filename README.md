# 🤖 MCP n8n — Bru.ia

Servidor MCP (Model Context Protocol) que conecta o **Cursor AI** ao **n8n**, permitindo criar, listar, editar e executar workflows diretamente pelo chat do Cursor.

---

## ⚡ Instalação rápida no Cursor

Edite o arquivo `mcp.json` do Cursor com as credenciais fornecidas pelo administrador:

**Localização do arquivo:**
- **Windows:** `%APPDATA%\Cursor\User\globalStorage\cursor.mcp\mcp.json`
- **Mac:** `~/Library/Application Support/Cursor/User/globalStorage/cursor.mcp/mcp.json`
- **Linux:** `~/.config/Cursor/User/globalStorage/cursor.mcp/mcp.json`

```jsonc
{
  "mcpServers": {
    "bmcp-n8n": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://bmcp.bru.ia.br/mcp",
        "--header",
        "X-MCP-KEY:SUA-CHAVE-PESSOAL",
        "--header",
        "X-N8N-URL:https://seu-n8n.exemplo.com",
        "--header",
        "X-N8N-API-KEY:sua-api-key-do-n8n"
      ]
    }
  }
}
```

> Após salvar, reinicie o Cursor. O servidor `bmcp-n8n` aparecerá disponível no chat.

---

## 🐳 Imagem Docker

A imagem oficial está publicada no Docker Hub por **Bruno Pelatieri Goulart**:

🔗 [https://hub.docker.com/u/brunopelatieri](https://hub.docker.com/u/brunopelatieri)

```
brunopelatieri/mcp-n8n-bruia:latest
```

> ⚠️ **Sempre use a tag `latest`** para garantir que está rodando a versão mais recente com todas as correções e melhorias.

---

## 🏗️ Como funciona

```
Cursor  ──stdio──▶  mcp-remote  ──HTTPS──▶  Servidor MCP  ──API──▶  n8n
```

1. O **Cursor** se comunica via stdio com o `mcp-remote` (proxy local instalado via `npx`)
2. O **mcp-remote** traduz stdio → HTTP e envia as requisições para o servidor remoto
3. O **Servidor MCP** autentica a requisição, valida os headers e chama a API do n8n
4. O **n8n** executa a operação e retorna o resultado

### Autenticação por camadas

| Header | Descrição |
|---|---|
| `X-MCP-KEY` | Chave pessoal do usuário — controla quem pode usar o servidor |
| `X-N8N-URL` | URL da instância n8n do usuário |
| `X-N8N-API-KEY` | API key da instância n8n do usuário |

Todos os três headers são **obrigatórios**. Sem eles a requisição é rejeitada.

### Ferramentas disponíveis

| Tool | Descrição |
|---|---|
| `list_workflows` | Lista todos os workflows |
| `search_workflows` | Busca workflows pelo nome |
| `get_workflow` | Retorna detalhes de um workflow pelo ID |
| `create_workflow` | Cria um novo workflow |
| `update_workflow` | Atualiza um workflow existente |
| `activate_workflow` | Ativa ou desativa um workflow |
| `delete_workflow` | Remove um workflow permanentemente |
| `get_executions` | Lista execuções recentes de um workflow |
| `execute_workflow_via_webhook` | Executa workflow via webhook |
| `get_workflow_as_template` | Exporta workflow como template reutilizável |

---

## 🖥️ Instalação no servidor (Docker Swarm + Portainer)

### Pré-requisitos

- Docker Swarm inicializado
- Portainer instalado
- Traefik configurado como reverse proxy com Let's Encrypt
- Rede Docker externa chamada `bru` criada:
  ```bash
  docker network create --driver overlay --attachable bru
  ```

---

### 1. Criar os secrets Docker

Os secrets armazenam credenciais de forma segura — nunca ficam expostos em variáveis de ambiente ou logs.

#### Secret: `n8n_url`
URL da instância n8n padrão do servidor (fallback — não usada se o usuário passar `X-N8N-URL`):
```bash
echo "https://seu-n8n.exemplo.com" | docker secret create n8n_url -
```

#### Secret: `n8n_api_key`
API key do n8n padrão do servidor:
```bash
echo "sua-api-key-aqui" | docker secret create n8n_api_key -
```

#### Secret: `mcp_allowed_keys`
Lista de usuários autorizados e suas chaves pessoais. O formato é `nome:chave` separados por vírgula:

```bash
# Gere uma chave para cada usuário:
openssl rand -hex 32
# Exemplo de saída: a1b2c3d4e5f6...

# Crie o secret com todos os usuários:
echo "bruno:CHAVE-DO-BRUNO,joao:CHAVE-DO-JOAO,maria:CHAVE-DA-MARIA" \
  | docker secret create mcp_allowed_keys -
```

> **Para adicionar ou revogar um usuário:** remova o secret antigo, recrie com a lista atualizada e atualize o service:
> ```bash
> docker secret rm mcp_allowed_keys
> echo "bruno:CHAVE-BRUNO,novousuario:NOVA-CHAVE" | docker secret create mcp_allowed_keys -
> docker service update --force mcp-bru_smcp
> ```

#### Verificar secrets criados:
```bash
docker secret ls
```

---

### 2. Deploy com Docker Compose no Portainer

No Portainer, vá em **Stacks → Add Stack**, cole o conteúdo abaixo e clique em **Deploy**:

```yaml
version: '3.8'

services:
  smcp:
    image: brunopelatieri/mcp-n8n-bruia:latest
    networks:
      - bru
    healthcheck:
      disable: true
    environment:
      - N8N_URL_FILE=/run/secrets/n8n_url
      - N8N_API_KEY_FILE=/run/secrets/n8n_api_key
      - MCP_ALLOWED_KEYS_FILE=/run/secrets/mcp_allowed_keys
      - NODE_ENV=production
    secrets:
      - n8n_url
      - n8n_api_key
      - mcp_allowed_keys
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
      labels:
        - traefik.enable=true
        - traefik.docker.network=bru
        - traefik.http.routers.bmcp.rule=Host(`bmcp.bru.ia.br`)
        - traefik.http.routers.bmcp.entrypoints=websecure
        - traefik.http.routers.bmcp.tls=true
        - traefik.http.routers.bmcp.tls.certresolver=letsencryptresolver
        - traefik.http.services.bmcp-svc.loadbalancer.server.port=3000
        # Mantém conexão SSE aberta (necessário para MCP)
        - traefik.http.middlewares.bmcp-buffer.buffering.maxRequestBodyBytes=0
        - traefik.http.routers.bmcp.middlewares=bmcp-buffer

networks:
  bru:
    external: true
    name: bru

secrets:
  n8n_url:
    external: true
  n8n_api_key:
    external: true
  mcp_allowed_keys:
    external: true
```

> ⚠️ Substitua `bmcp.bru.ia.br` pelo seu próprio domínio.

---

### 3. Verificar o deploy

```bash
# Ver status do service
docker service ps mcp-bru_smcp

# Ver logs
docker service logs mcp-bru_smcp --follow

# Testar o health endpoint
curl https://bmcp.bru.ia.br/health
```

Resposta esperada:
```json
{ "status": "ok", "time": "2026-02-28T..." }
```

---

### 4. Testar uma tool via curl

```bash
curl -X POST https://bmcp.bru.ia.br/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-MCP-KEY:sua-chave" \
  -H "X-N8N-URL:https://seu-n8n.exemplo.com" \
  -H "X-N8N-API-KEY:sua-api-key" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "list_workflows",
      "arguments": {}
    }
  }'
```

---

## 👤 Gerenciar usuários

### Adicionar novo usuário

1. Gere uma chave:
   ```bash
   openssl rand -hex 32
   ```

2. Atualize o secret `mcp_allowed_keys`:
   ```bash
   docker secret rm mcp_allowed_keys
   echo "bruno:CHAVE-BRUNO,novousuario:NOVA-CHAVE" | docker secret create mcp_allowed_keys -
   docker service update --force mcp-bru_smcp
   ```

3. Envie para o usuário o `mcp.json` com a chave gerada.

### Revogar acesso

Remova a entrada do usuário da lista e atualize o secret — sem afetar os demais usuários.

---

## 🔒 Segurança

- Comunicação sempre via **HTTPS** (Traefik + Let's Encrypt)
- Secrets nunca expostos em variáveis de ambiente ou logs
- Cada usuário tem **chave individual** — revogação granular sem afetar outros
- Cada usuário usa suas **próprias credenciais n8n** — sem compartilhamento
- Headers `X-MCP-KEY`, `X-N8N-URL` e `X-N8N-API-KEY` são todos obrigatórios

---

## 🛠️ Tecnologias

- **Node.js** com Express
- **Protocolo MCP** (Model Context Protocol) — JSON-RPC 2.0 via SSE
- **mcp-remote** — proxy stdio↔HTTP para Cursor
- **Docker Swarm** com secrets nativos
- **Traefik** como reverse proxy com TLS automático