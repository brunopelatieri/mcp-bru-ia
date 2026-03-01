import "./secrets-reader.js";
import express  from "express";
import fetch    from "node-fetch";

const PORT                = parseInt(process.env.PORT ?? "3000", 10);

// ─── n8n API ──────────────────────────────────────────────────────────────────
function makeN8nRequest(n8nUrl, n8nApiKey) {
    return async function(path, method = "GET", body) {
        const base = n8nUrl.endsWith("/") ? n8nUrl : `${n8nUrl}/`;
        const url  = `${base}api/v1/${path.replace(/^\//, "")}`;
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

// ─── Tool definitions ─────────────────────────────────────────────────────────
function getToolDefinitions() {
    return [
        {
            name: "list_workflows",
            description: "Lista todos os workflows do n8n",
            inputSchema: { type: "object", properties: {}, required: [] }
        },
        {
            name: "search_workflows",
            description: "Busca workflows pelo nome",
            inputSchema: { type: "object", properties: { name: { type: "string", description: "Texto a buscar" } }, required: ["name"] }
        },
        {
            name: "get_workflow",
            description: "Retorna detalhes de um workflow pelo ID",
            inputSchema: { type: "object", properties: { id: { type: "string", description: "ID do workflow" } }, required: ["id"] }
        },
        {
            name: "create_workflow",
            description: "Cria um novo workflow no n8n",
            inputSchema: {
                type: "object",
                properties: {
                    name:        { type: "string", description: "Nome do workflow" },
                    nodes:       { type: "array",  description: "Array de nós", items: { type: "object" } },
                    connections: { type: "object", description: "Conexões entre nós" }
                },
                required: ["name"]
            }
        },
        {
            name: "update_workflow",
            description: "Atualiza um workflow existente",
            inputSchema: {
                type: "object",
                properties: {
                    id:          { type: "string", description: "ID do workflow" },
                    name:        { type: "string", description: "Novo nome (opcional)" },
                    nodes:       { type: "array",  description: "Nós (opcional)", items: { type: "object" } },
                    connections: { type: "object", description: "Conexões (opcional)" }
                },
                required: ["id"]
            }
        },
        {
            name: "activate_workflow",
            description: "Ativa ou desativa um workflow",
            inputSchema: {
                type: "object",
                properties: {
                    id:     { type: "string",  description: "ID do workflow" },
                    active: { type: "boolean", description: "true para ativar, false para desativar" }
                },
                required: ["id", "active"]
            }
        },
        {
            name: "delete_workflow",
            description: "Remove um workflow permanentemente",
            inputSchema: { type: "object", properties: { id: { type: "string", description: "ID do workflow" } }, required: ["id"] }
        },
        {
            name: "get_executions",
            description: "Lista execuções recentes de um workflow",
            inputSchema: {
                type: "object",
                properties: {
                    workflowId: { type: "string", description: "ID do workflow" },
                    limit:      { type: "number", description: "Limite de resultados (padrão 10)" }
                },
                required: ["workflowId"]
            }
        },
        {
            name: "execute_workflow_via_webhook",
            description: "Executa um workflow via webhook",
            inputSchema: {
                type: "object",
                properties: {
                    webhookUrl: { type: "string", description: "URL do webhook" },
                    payload:    { type: "object", description: "Body a enviar (opcional)" }
                },
                required: ["webhookUrl"]
            }
        },
        {
            name: "get_workflow_as_template",
            description: "Exporta workflow como template reutilizável",
            inputSchema: { type: "object", properties: { id: { type: "string", description: "ID do workflow" } }, required: ["id"] }
        }
    ];
}

// ─── Tool executor ────────────────────────────────────────────────────────────
async function executeTool(name, args, n8nRequest) {
    const ok  = (texts) => ({ content: Array.isArray(texts) ? texts.map(t => ({ type: "text", text: t })) : [{ type: "text", text: texts }] });
    const err = (msg)   => ({ content: [{ type: "text", text: `Erro: ${msg}` }], isError: true });

    try {
        switch(name) {
            case "list_workflows": {
                const data = await n8nRequest("/workflows");
                const list = data?.data ?? data;
                return ok([`${Array.isArray(list) ? list.length : "?"} workflow(s) encontrado(s).`, JSON.stringify(data, null, 2)]);
            }
            case "search_workflows": {
                const data = await n8nRequest("/workflows");
                const list = (data?.data ?? data).filter(w => w.name?.toLowerCase().includes((args.name ?? "").toLowerCase()));
                return ok([`${list.length} encontrado(s) com "${args.name}".`, JSON.stringify(list.map(w => ({ id: w.id, name: w.name, active: w.active })), null, 2)]);
            }
            case "get_workflow": {
                const data = await n8nRequest(`/workflows/${args.id}`);
                return ok([`Workflow: "${data.name}" (ativo: ${data.active})`, JSON.stringify(data, null, 2)]);
            }
            case "create_workflow": {
                const nodes       = args.nodes       ?? [];
                const connections = args.connections ?? {};
                const data = await n8nRequest("/workflows", "POST", { name: args.name, nodes, connections, settings: {} });
                return ok(["Workflow criado.", JSON.stringify({ id: data.id, name: data.name }, null, 2)]);
            }
            case "update_workflow": {
                const ex = await n8nRequest(`/workflows/${args.id}`);
                const body = {
                    name:        args.name        ?? ex.name,
                    nodes:       args.nodes       ?? ex.nodes,
                    connections: args.connections ?? ex.connections,
                    settings:    ex.settings      ?? {}
                };
                const up = await n8nRequest(`/workflows/${args.id}`, "PUT", body);
                return ok(["Workflow atualizado.", JSON.stringify({ id: up.id, name: up.name }, null, 2)]);
            }
            case "activate_workflow": {
                await n8nRequest(`/workflows/${args.id}/${args.active ? "activate" : "deactivate"}`, "POST");
                return ok(`Workflow ${args.id} ${args.active ? "ativado" : "desativado"}.`);
            }
            case "delete_workflow": {
                await n8nRequest(`/workflows/${args.id}`, "DELETE");
                return ok(`Workflow ${args.id} removido.`);
            }
            case "get_executions": {
                const data = await n8nRequest(`/executions?workflowId=${args.workflowId}&limit=${args.limit ?? 10}`);
                return ok([`${(data?.data ?? data).length ?? "?"} execução(ões).`, JSON.stringify(data, null, 2)]);
            }
            case "execute_workflow_via_webhook": {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 15000);
                const res = await fetch(args.webhookUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(args.payload ?? {}),
                    signal: ctrl.signal
                });
                clearTimeout(t);
                const text = await res.text();
                let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
                if (!res.ok) return err(`Webhook erro (${res.status}): ${text}`);
                return ok([`Webhook OK (${res.status}).`, typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)]);
            }
            case "get_workflow_as_template": {
                const data = await n8nRequest(`/workflows/${args.id}`);
                const tpl = {
                    name: `${data.name} (cópia)`,
                    nodes: data.nodes.map(n => { const c={...n}; delete c.id; return c; }),
                    connections: data.connections,
                    settings: data.settings ?? {}
                };
                return ok([`Template de "${data.name}". Use com create_workflow.`, JSON.stringify(tpl, null, 2)]);
            }
            default:
                return err(`Tool desconhecida: ${name}`);
        }
    } catch(e) {
        return err(e.message);
    }
}

// ─── JSON-RPC ─────────────────────────────────────────────────────────────────
function jsonrpc(id, result) { return { jsonrpc: "2.0", id: id ?? null, result }; }
function jsonrpcError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/.well-known/oauth-authorization-server", (_req, res) => res.status(404).end());
app.get("/.well-known/openid-configuration",       (_req, res) => res.status(404).end());
app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

app.get("/mcp", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(ping); } }, 15000);
    req.on("close", () => clearInterval(ping));
});

app.post("/mcp", async (req, res) => {
    const { method, params, id } = req.body ?? {};
    // Auth — valida X-MCP-KEY contra lista de chaves por usuário
    // MCP_ALLOWED_KEYS = "nome1:chave1,nome2:chave2,..." (secret Docker)
    if (!method?.startsWith("notifications/")) {
        const clientKey = req.headers["x-mcp-key"] ?? "";
        const rawKeys   = process.env.MCP_ALLOWED_KEYS ?? "";

        if (!rawKeys) {
            console.log(`[auth] MCP_ALLOWED_KEYS não configurado no servidor`);
            return res.status(500).json({ jsonrpc:"2.0", error:{ code:-32000, message:"Servidor mal configurado: MCP_ALLOWED_KEYS ausente" }, id: req.body?.id ?? null });
        }

        // Parseia "nome:chave,nome:chave" → Map { chave → nome }
        const keyMap = new Map(
            rawKeys.split(",")
                   .map(e => e.trim().split(":"))
                   .filter(([n, k]) => n && k)
                   .map(([name, ...rest]) => [rest.join(":"), name])
        );

        if (!clientKey || !keyMap.has(clientKey)) {
            console.log(`[auth] chave inválida ou ausente: "${clientKey.slice(0,8)}..."`);
            return res.status(401).json({ jsonrpc:"2.0", error:{ code:-32000, message:"Unauthorized: X-MCP-KEY inválida ou ausente" }, id: req.body?.id ?? null });
        }

        console.log(`[auth] usuário autenticado: ${keyMap.get(clientKey)}`);
    }

    if (method?.startsWith("notifications/")) return res.status(202).end();

    const wantsSSE = (req.headers["accept"] ?? "").includes("text/event-stream");
    const send = (payload) => {
        if (wantsSSE) {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
            res.end();
        } else {
            res.json(payload);
        }
    };

    const n8nUrl    = req.headers["x-n8n-url"]     ?? "";
    const n8nApiKey = req.headers["x-n8n-api-key"] ?? "";

    if (!n8nUrl) {
        return send(jsonrpcError(id, -32000, "Header X-N8N-URL obrigatório. Configure sua URL do n8n."));
    }
    if (!n8nApiKey) {
        return send(jsonrpcError(id, -32000, "Header X-N8N-API-KEY obrigatório. Configure sua API key do n8n."));
    }

    const n8nRequest = makeN8nRequest(n8nUrl, n8nApiKey);

    try {
        switch(method) {
            case "initialize":
                return send(jsonrpc(id, {
                    protocolVersion: params?.protocolVersion ?? "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "n8n-mcp", version: "1.0.0" }
                }));
            case "tools/list":
                return send(jsonrpc(id, { tools: getToolDefinitions() }));
            case "tools/call": {
                const toolName = params?.name;
                const toolArgs = params?.arguments ?? {};
                //console.log(`[tools/call] ${toolName} args=${JSON.stringify(toolArgs)}`);
                if (!toolName) return send(jsonrpcError(id, -32602, "params.name é obrigatório"));
                const result = await executeTool(toolName, toolArgs, n8nRequest);
                return send(jsonrpc(id, result));
            }
            case "ping":
                return send(jsonrpc(id, {}));
            default:
                return send(jsonrpcError(id, -32601, `Method not found: ${method}`));
        }
    } catch(e) {
        console.error(`[POST /mcp] ERROR: ${e.message}`);
        return send(jsonrpcError(id, -32000, e.message));
    }
});

app.use((err, req, res, _next) => {
    console.error(`[ERROR]`, err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`╔══════════════════════════════════════════════╗`);
    console.log(`║    n8n MCP Server v5 — JSON-RPC direto       ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  POST /mcp  → JSON-RPC sem SDK               ║`);
    console.log(`║  GET  /mcp  → SSE keep-alive                 ║`);
    console.log(`║  GET  /health                                 ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  n8n: credenciais via headers (X-N8N-URL + X-N8N-API-KEY)     ║`);
    console.log(`╚══════════════════════════════════════════════╝`);
});