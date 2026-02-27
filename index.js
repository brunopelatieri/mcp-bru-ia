import "./secrets-reader.js";
import { McpServer }                     from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express                           from "express";
import fetch                             from "node-fetch";
import { randomUUID }                    from "node:crypto";

const DEFAULT_N8N_URL     = process.env.N8N_URL        ?? "";
const DEFAULT_N8N_API_KEY = process.env.N8N_API_KEY    ?? "";
const PORT                = parseInt(process.env.PORT  ?? "3000", 10);

function makeN8nRequest(n8nUrl, n8nApiKey) {
    return async function(path, method = "GET", body) {
        const base = n8nUrl.endsWith("/") ? n8nUrl : `${n8nUrl}/`;
        const url  = `${base}api/v1/${path.startsWith("/") ? path.slice(1) : path}`;
        const ctrl = new AbortController();
        const t    = setTimeout(() => ctrl.abort(), 10000);
        try {
            const res = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json", "X-N8N-API-KEY": n8nApiKey },
                body: body ? JSON.stringify(body) : undefined,
                signal: ctrl.signal
            });
            clearTimeout(t);
            if (!res.ok) throw new Error(`n8n error (${res.status}): ${await res.text()}`);
            return res.json();
        } catch(e) { clearTimeout(t); throw e; }
    };
}

function createMcpServer(n8nRequest) {
    const server = new McpServer({ name: "n8n-mcp", version: "1.0.0" });

    server.tool("list_workflows", "Lista todos os workflows do n8n", {}, async () => {
        try {
            const data = await n8nRequest("/workflows");
            const list = data?.data ?? data;
            return { content: [
                { type: "text", text: `${Array.isArray(list) ? list.length : "?"} workflow(s) encontrado(s).` },
                { type: "text", text: JSON.stringify(data, null, 2) }
            ]};
        } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
    });

    server.tool("search_workflows", "Busca workflows pelo nome",
        { name: { type: "string", description: "Texto a buscar" } },
        async ({ name }) => {
            try {
                const data = await n8nRequest("/workflows");
                const list = (data?.data ?? data).filter(w => w.name?.toLowerCase().includes(name.toLowerCase()));
                return { content: [
                    { type: "text", text: `${list.length} encontrado(s) com "${name}".` },
                    { type: "text", text: JSON.stringify(list.map(w => ({ id: w.id, name: w.name, active: w.active })), null, 2) }
                ]};
            } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
        }
    );

    server.tool("get_workflow", "Retorna detalhes de um workflow pelo ID",
        { id: { type: "string", description: "ID do workflow" } },
        async ({ id }) => {
            try {
                const data = await n8nRequest(`/workflows/${id}`);
                return { content: [
                    { type: "text", text: `Workflow: "${data.name}" (ativo: ${data.active})` },
                    { type: "text", text: JSON.stringify(data, null, 2) }
                ]};
            } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
        }
    );

    server.tool("create_workflow", "Cria um novo workflow",
        {
            name:        { type: "string",  description: "Nome do workflow" },
            nodes:       { type: "string",  description: "Array de nós em JSON string" },
            connections: { type: "string",  description: "Conexões entre nós em JSON string" }
        },
        async ({ name, nodes, connections }) => {
            try {
                const parsedNodes       = typeof nodes       === "string" ? JSON.parse(nodes)       : (nodes       ?? []);
                const parsedConnections = typeof connections === "string" ? JSON.parse(connections) : (connections ?? {});
                const data = await n8nRequest("/workflows", "POST", { name, nodes: parsedNodes, connections: parsedConnections, settings: {} });
                return { content: [
                    { type: "text", text: "Workflow criado." },
                    { type: "text", text: JSON.stringify({ id: data.id, name: data.name }, null, 2) }
                ]};
            } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
        }
    );

    server.tool("update_workflow", "Atualiza um workflow",
        {
            id:          { type: "string", description: "ID do workflow" },
            name:        { type: "string", description: "Novo nome (opcional)" },
            nodes:       { type: "string", description: "Nós em JSON string (opcional)" },
            connections: { type: "string", description: "Conexões em JSON string (opcional)" }
        },
        async ({ id, name, nodes, connections }) => {
            try {
                const parsedNodes       = nodes       ? (typeof nodes       === "string" ? JSON.parse(nodes)       : nodes)       : undefined;
                const parsedConnections = connections ? (typeof connections === "string" ? JSON.parse(connections) : connections) : undefined;
                const ex = await n8nRequest(`/workflows/${id}`);
                const up = await n8nRequest(`/workflows/${id}`, "PUT", {
                    id: ex.id, staticData: ex.staticData, settings: ex.settings,
                    versionId: ex.versionId, active: ex.active,
                    name: name ?? ex.name,
                    nodes: parsedNodes ?? ex.nodes,
                    connections: parsedConnections ?? ex.connections
                });
                return { content: [
                    { type: "text", text: "Workflow atualizado." },
                    { type: "text", text: JSON.stringify({ id: up.id, name: up.name }, null, 2) }
                ]};
            } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
        }
    );

    server.tool("activate_workflow", "Ativa ou desativa um workflow",
        { id: { type: "string", description: "ID" }, active: { type: "boolean", description: "true=ativar" } },
        async ({ id, active }) => {
            try {
                await n8nRequest(`/workflows/${id}/${active ? "activate" : "deactivate"}`, "POST");
                return { content: [{ type: "text", text: `Workflow ${id} ${active ? "ativado" : "desativado"}.` }] };
            } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
        }
    );

    server.tool("delete_workflow", "Remove um workflow",
        { id: { type: "string", description: "ID" } },
        async ({ id }) => {
            try {
                await n8nRequest(`/workflows/${id}`, "DELETE");
                return { content: [{ type: "text", text: `Workflow ${id} removido.` }] };
            } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
        }
    );

    server.tool("get_executions", "Lista execuções recentes de um workflow",
        { workflowId: { type: "string", description: "ID do workflow" }, limit: { type: "number", description: "Limite (padrão 10)" } },
        async ({ workflowId, limit = 10 }) => {
            try {
                const data = await n8nRequest(`/executions?workflowId=${workflowId}&limit=${limit}`);
                return { content: [
                    { type: "text", text: `${(data?.data ?? data).length ?? "?"} execução(ões).` },
                    { type: "text", text: JSON.stringify(data, null, 2) }
                ]};
            } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
        }
    );

    server.tool("execute_workflow_via_webhook", "Executa workflow via webhook",
        { webhookUrl: { type: "string", description: "URL do webhook" }, payload: { type: "string", description: "Body em JSON string (opcional)" } },
        async ({ webhookUrl, payload }) => {
            const parsedPayload = payload ? (typeof payload === "string" ? JSON.parse(payload) : payload) : {};
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15000);
            try {
                const res = await fetch(webhookUrl, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(parsedPayload), signal:ctrl.signal });
                clearTimeout(t);
                const text = await res.text();
                let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
                if (!res.ok) return { content: [{ type:"text", text:`Webhook erro (${res.status}): ${text}` }], isError: true };
                return { content: [
                    { type: "text", text: `Webhook OK (${res.status}).` },
                    { type: "text", text: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2) }
                ]};
            } catch(e) { clearTimeout(t); return { content: [{ type:"text", text:`Erro: ${e.message}` }], isError: true }; }
        }
    );

    server.tool("get_workflow_as_template", "Exporta workflow como template reutilizável",
        { id: { type: "string", description: "ID do workflow" } },
        async ({ id }) => {
            try {
                const data = await n8nRequest(`/workflows/${id}`);
                const tpl = {
                    name: `${data.name} (cópia)`,
                    nodes: data.nodes.map(n => { const c={...n}; delete c.id; return c; }),
                    connections: data.connections,
                    settings: data.settings ?? {}
                };
                return { content: [
                    { type: "text", text: `Template de "${data.name}". Use com create_workflow.` },
                    { type: "text", text: JSON.stringify(tpl, null, 2) }
                ]};
            } catch(e) { return { content: [{ type: "text", text: `Erro: ${e.message}` }], isError: true }; }
        }
    );

    return server;
}

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/.well-known/oauth-authorization-server", (_req, res) => res.status(404).end());
app.get("/.well-known/openid-configuration",       (_req, res) => res.status(404).end());
app.get("/health", (_req, res) => res.json({ status:"ok", time:new Date().toISOString() }));

// ─── MCP Handler — STATELESS puro ─────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
    req.headers["accept"]       = "application/json, text/event-stream";
    req.headers["content-type"] = "application/json";

    const method = req.body?.method ?? "unknown";
    console.log(`[POST /mcp] method=${method}`);

    // notifications/initialized não tem resposta — retorna 202 diretamente
    // O SDK stateless rejeita notificações sem initialize prévio na mesma instância
    if (method === "notifications/initialized") {
        res.status(202).end();
        console.log(`[POST /mcp] ok method=${method} (202 direto)`);
        return;
    }

    const n8nUrl    = DEFAULT_N8N_URL;
    const n8nApiKey = DEFAULT_N8N_API_KEY;

    if (!n8nUrl || !n8nApiKey) {
        return res.status(500).json({ jsonrpc:"2.0", error:{ code:-32000, message:"N8N_URL/N8N_API_KEY não configurados" }, id: req.body?.id ?? null });
    }

    try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server    = createMcpServer(makeN8nRequest(n8nUrl, n8nApiKey));
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        console.log(`[POST /mcp] ok method=${method}`);
    } catch(e) {
        console.error(`[POST /mcp] ERROR method=${method}: ${e.message}`);
        if (!res.headersSent) res.status(500).json({ jsonrpc:"2.0", error:{ code:-32000, message:e.message }, id: req.body?.id ?? null });
    }
});

// GET /mcp — mcp-remote abre um SSE stream após connect.
// Com transport stateless, retornamos um SSE keep-alive simples.
app.get("/mcp", (req, res) => {
    console.log(`[GET /mcp] abrindo SSE keep-alive`);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const ping = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { clearInterval(ping); }
    }, 15000);
    req.on("close", () => {
        clearInterval(ping);
        console.log(`[GET /mcp] cliente desconectou`);
    });
});

app.use((err, req, res, _next) => {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`╔══════════════════════════════════════════════╗`);
    console.log(`║    n8n MCP Server v4 — Stateless puro        ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  POST /mcp  → stateless (sem sessão)         ║`);
    console.log(`║  GET  /mcp  → SSE keep-alive                 ║`);
    console.log(`║  GET  /health                                 ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  n8n: ${DEFAULT_N8N_URL ? "configurado ✓" : "NÃO configurado ✗"}                     ║`);
    console.log(`╚══════════════════════════════════════════════╝`);
});