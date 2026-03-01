# 🤖 MCP n8n — Bru.ia
_Model Context Protocol Server for n8n Automation_

<p align="center">
  <a href="https://n8n.io/" target="_blank">
    <img src="https://img.shields.io/badge/n8n-Automation-EA4B71?logo=n8n&logoColor=white" />
  </a>
  <a href="https://cursor.sh/" target="_blank">
    <img src="https://img.shields.io/badge/Cursor-AI%20Integration-000000?logo=cursor&logoColor=white" />
  </a>
  <a href="https://www.docker.com/" target="_blank">
    <img src="https://img.shields.io/badge/Docker-Containerized-2496ED?logo=docker&logoColor=white" />
  </a>
  <a href="https://traefik.io/" target="_blank">
    <img src="https://img.shields.io/badge/Traefik-Reverse%20Proxy-24A1C1?logo=traefikproxy&logoColor=white" />
  </a>
</p>

---

## 🇧🇷 Visão Geral

Servidor **MCP (Model Context Protocol)** que conecta o **Cursor AI** ao **n8n**, permitindo criar, listar, editar e executar workflows diretamente pelo chat.

---

## 🏗️ Arquitetura

```
Cursor  ──stdio──▶  mcp-remote  ──HTTPS──▶  MCP Server  ──API──▶  n8n
```

---

## ⚡ Instalação no Cursor

### Localização do mcp.json

| Sistema | Caminho |
|----------|----------|
| Windows | %APPDATA%\Cursor\User\globalStorage\cursor.mcp\mcp.json |
| Mac | ~/Library/Application Support/Cursor/User/globalStorage/cursor.mcp/mcp.json |
| Linux | ~/.config/Cursor/User/globalStorage/cursor.mcp/mcp.json |

### Configuração

```jsonc
{
  "mcpServers": {
    "bmcp-n8n": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@latest",
        "https://bmcp.seudominio.com/mcp",
        "--header",
        "X-MCP-KEY:SUA-CHAVE",
        "--header",
        "X-N8N-URL:https://seu-n8n.com",
        "--header",
        "X-N8N-API-KEY:sua-api-key"
      ]
    }
  }
}
```

Reinicie o Cursor após salvar.

---

## 🐳 Docker Image

```
brunopelatieri/mcp-n8n-bruia:latest
```

---

## 🔐 Autenticação

Headers obrigatórios:

- X-MCP-KEY
- X-N8N-URL
- X-N8N-API-KEY

---

## 🛠️ Tools

- list_workflows
- search_workflows
- get_workflow
- create_workflow
- update_workflow
- activate_workflow
- delete_workflow
- get_executions
- execute_workflow_via_webhook
- get_workflow_as_template

---

## 🖥️ Deploy Docker Swarm

Criar rede:

```bash
docker network create --driver overlay --attachable bru
```

Criar secrets:

```bash
docker secret create n8n_url -
docker secret create n8n_api_key -
docker secret create mcp_allowed_keys -
```

Deploy via Portainer com stack apropriada.

---

## 🔒 Segurança

✔ HTTPS  
✔ Secrets Docker  
✔ Chaves individuais  
✔ JSON-RPC 2.0 via SSE  

---

## 👤 Autor

Bruno Pelatieri Goulart  
Enterprise AI Workflow Architect
