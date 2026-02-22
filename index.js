/**
 * n8n MCP Server — StreamableHTTP
 *
 * Transporte : StreamableHTTP (MCP spec 2025-03-26)
 * Infraestrutura: Docker Swarm + Traefik + Portainer (VPS Ubuntu 22.04)
 *
 * ─── Sessões ─────────────────────────────────────────────────────────────────
 * Em modo single-replica (padrão recomendado no Swarm), o Map em memória é
 * suficiente — o Swarm reinicia o container automaticamente em falha.
 *
 * Em modo multi-replica, sessões ficam presas à réplica que as criou.
 * Para escalar horizontalmente sem sticky sessions, use Redis:
 *   defina REDIS_URL=redis://redis:6379 na env e adicione o serviço Redis
 *   no docker-compose. O código detecta automaticamente e usa Redis se disponível.
 *
 * ─── Multi-tenant ─────────────────────────────────────────────────────────────
 * Cada requisição pode trazer suas próprias credenciais do n8n via headers:
 *   x-n8n-url      → URL da instância n8n do tenant
 *   x-n8n-api-key  → API key do tenant
 * Se ausentes, usa N8N_URL e N8N_API_KEY da env (modo single-tenant).
 *
 * ─── Segurança do servidor ────────────────────────────────────────────────────
 * Se SERVER_API_KEY estiver definida, exige Authorization: Bearer <key>.
 */

// Carrega Docker Secrets (_FILE vars) antes de qualquer outra coisa
import "./secrets-reader.js";

import { McpServer }                        from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport }    from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest }              from "@modelcontextprotocol/sdk/types.js";
import express                              from "express";
import { randomUUID }                       from "node:crypto";
import fetch                                from "node-fetch";

// ─── Configuração ──────────────────────────────────────────────────────────────

const DEFAULT_N8N_URL     = process.env.N8N_URL        ?? "";
const DEFAULT_N8N_API_KEY = process.env.N8N_API_KEY    ?? "";
const PORT                = parseInt(process.env.PORT  ?? "3000", 10);
const SERVER_API_KEY      = process.env.SERVER_API_KEY ?? "";
const REDIS_URL           = process.env.REDIS_URL      ?? "";

// ─── Session Store ─────────────────────────────────────────────────────────────
// Abstração que suporta Map (single-replica) ou Redis (multi-replica).
// Em modo Redis, serializa apenas os metadados da sessão (credenciais + sessionId).
// O transport em si não é serializado — cada réplica recria o transport ao receber
// uma requisição com um sessionId existente.

let redisClient = null;

if (REDIS_URL) {
    try {
        // Importação dinâmica — Redis é opcional. Se não instalado, cai para Map.
        const { createClient } = await import("redis");
        redisClient = createClient({ url: REDIS_URL });
        redisClient.on("error", (err) => console.error("[redis] erro:", err.message));
        await redisClient.connect();
        console.log(`[redis] conectado em ${REDIS_URL}`);
    } catch (err) {
        console.warn(`[redis] não disponível (${err.message}). Usando Map em memória.`);
        redisClient = null;
    }
}

/**
 * sessionStore: Map em memória → { transport, n8nUrl, n8nApiKey }
 * Em modo Redis, apenas { n8nUrl, n8nApiKey } são armazenados remotamente.
 * O transport permanece local (Map) e é recriado se a réplica mudar.
 */
/** @type {Map<string, { transport: StreamableHTTPServerTransport, n8nUrl: string, n8nApiKey: string }>} */
const localTransports = new Map();

async function sessionExists(sessionId) {
    if (redisClient) {
        const val = await redisClient.get(`mcp:session:${sessionId}`);
        return val !== null;
    }
    return localTransports.has(sessionId);
}

async function saveSession(sessionId, n8nUrl, n8nApiKey, transport) {
    localTransports.set(sessionId, { transport, n8nUrl, n8nApiKey });
    if (redisClient) {
        // TTL de 2h — sessão inativa expira automaticamente
        await redisClient.setEx(
            `mcp:session:${sessionId}`,
            7200,
            JSON.stringify({ n8nUrl, n8nApiKey })
        );
    }
}

async function getSession(sessionId) {
    return localTransports.get(sessionId) ?? null;
}

async function deleteSession(sessionId) {
    const session = localTransports.get(sessionId);
    localTransports.delete(sessionId);
    if (redisClient) {
        await redisClient.del(`mcp:session:${sessionId}`);
    }
    return session;
}

function activeSessionCount() {
    return localTransports.size;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCredentials(req) {
    const url    = req.headers["x-n8n-url"]     || DEFAULT_N8N_URL;
    const apiKey = req.headers["x-n8n-api-key"] || DEFAULT_N8N_API_KEY;

    if (!url)    throw new Error("n8n URL não configurada. Defina N8N_URL ou envie x-n8n-url.");
    if (!apiKey) throw new Error("n8n API Key não configurada. Defina N8N_API_KEY ou envie x-n8n-api-key.");

    return { url, apiKey };
}

function makeN8nRequest(n8nUrl, n8nApiKey) {
    return async function n8nRequest(path, method = "GET", body) {
        const baseUrl  = n8nUrl.endsWith("/") ? n8nUrl : `${n8nUrl}/`;
        const fullPath = path.startsWith("/") ? path.slice(1) : path;
        const url      = `${baseUrl}api/v1/${fullPath}`;

        const controller = new AbortController();
        const timeout    = setTimeout(() => controller.abort(), 10000);

        try {
            const res = await fetch(url, {
                method,
                headers: {
                    "Content-Type":  "application/json",
                    "Authorization": `Bearer ${n8nApiKey}`
                },
                body:   body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`n8n error (${res.status}): ${text}`);
            }
            return await res.json();
        } catch (err) {
            clearTimeout(timeout);
            throw err;
        }
    };
}

// ─── Fábrica McpServer ────────────────────────────────────────────────────────

function createMcpServer(n8nRequest) {
    const server = new McpServer({ name: "n8n-mcp", version: "1.0.0" });

    // ── list_workflows ────────────────────────────────────────────────────────
    server.tool("list_workflows", "Lista todos os workflows do n8n", {}, async () => {
        try {
            const data  = await n8nRequest("/workflows");
            const list  = data?.data ?? data;
            const count = Array.isArray(list) ? list.length : "?";
            return { content: [
                { type: "text", text: `${count} workflow(s) encontrado(s).` },
                { type: "text", text: JSON.stringify(data, null, 2) }
            ]};
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    });

    // ── search_workflows ──────────────────────────────────────────────────────
    server.tool(
        "search_workflows",
        "Busca workflows pelo nome (parcial ou completo, case-insensitive). Use antes de get_workflow quando não souber o ID exato.",
        { name: { type: "string", description: "Texto a buscar no nome do workflow" } },
        async ({ name }) => {
            try {
                const data = await n8nRequest("/workflows");
                const list = data?.data ?? data;
                if (!Array.isArray(list)) throw new Error("Resposta inesperada da API.");

                const matches = list.filter(wf => wf.name?.toLowerCase().includes(name.toLowerCase()));
                return { content: [
                    {
                        type: "text",
                        text: matches.length > 0
                            ? `${matches.length} workflow(s) encontrado(s) com "${name}".`
                            : `Nenhum workflow encontrado com "${name}".`
                    },
                    { type: "text", text: JSON.stringify(matches.map(wf => ({ id: wf.id, name: wf.name, active: wf.active })), null, 2) }
                ]};
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    // ── get_workflow ──────────────────────────────────────────────────────────
    server.tool(
        "get_workflow",
        "Retorna os detalhes completos de um workflow pelo ID",
        { id: { type: "string", description: "ID do workflow no n8n" } },
        async ({ id }) => {
            try {
                const data = await n8nRequest(`/workflows/${id}`);
                return { content: [
                    { type: "text", text: `Workflow encontrado: "${data.name}" (ativo: ${data.active}).` },
                    { type: "text", text: JSON.stringify(data, null, 2) }
                ]};
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    // ── create_workflow ───────────────────────────────────────────────────────
    server.tool(
        "create_workflow",
        "Cria um novo workflow no n8n",
        {
            name:        { type: "string", description: "Nome do workflow" },
            nodes:       { type: "array",  description: "Array de nós do workflow" },
            connections: { type: "object", description: "Objeto de conexões entre os nós" }
        },
        async ({ name, nodes, connections }) => {
            try {
                const data = await n8nRequest("/workflows", "POST", { name, nodes, connections, settings: {} });
                return { content: [
                    { type: "text", text: `Workflow criado com sucesso.` },
                    { type: "text", text: JSON.stringify({ id: data.id, name: data.name, active: data.active }, null, 2) }
                ]};
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    // ── update_workflow ───────────────────────────────────────────────────────
    server.tool(
        "update_workflow",
        "Atualiza um workflow existente no n8n. Faz GET antes do PUT para preservar staticData, settings, versionId e active flag. Todos os campos são opcionais.",
        {
            id:          { type: "string", description: "ID do workflow a ser atualizado" },
            name:        { type: "string", description: "Novo nome (opcional)" },
            nodes:       { type: "array",  description: "Nós atualizados (opcional)" },
            connections: { type: "object", description: "Conexões atualizadas (opcional)" }
        },
        async ({ id, name, nodes, connections }) => {
            try {
                const existing = await n8nRequest(`/workflows/${id}`);
                const payload  = {
                    id:          existing.id,
                    staticData:  existing.staticData,
                    settings:    existing.settings,
                    versionId:   existing.versionId,
                    active:      existing.active,
                    name:        name        ?? existing.name,
                    nodes:       nodes       ?? existing.nodes,
                    connections: connections ?? existing.connections
                };
                const updated = await n8nRequest(`/workflows/${id}`, "PUT", payload);
                return { content: [
                    { type: "text", text: `Workflow atualizado com sucesso.` },
                    { type: "text", text: JSON.stringify({ id: updated.id, name: updated.name, versionId: updated.versionId, active: updated.active }, null, 2) }
                ]};
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    // ── activate_workflow ─────────────────────────────────────────────────────
    server.tool(
        "activate_workflow",
        "Ativa ou desativa um workflow no n8n",
        {
            id:     { type: "string",  description: "ID do workflow" },
            active: { type: "boolean", description: "true para ativar, false para desativar" }
        },
        async ({ id, active }) => {
            try {
                await n8nRequest(active ? `/workflows/${id}/activate` : `/workflows/${id}/deactivate`, "POST");
                return { content: [{ type: "text", text: active ? `Workflow ${id} ativado.` : `Workflow ${id} desativado.` }] };
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    // ── delete_workflow ───────────────────────────────────────────────────────
    server.tool(
        "delete_workflow",
        "Remove um workflow pelo ID",
        { id: { type: "string", description: "ID do workflow a ser removido" } },
        async ({ id }) => {
            try {
                await n8nRequest(`/workflows/${id}`, "DELETE");
                return { content: [{ type: "text", text: `Workflow ${id} removido com sucesso.` }] };
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    // ── execute_workflow_via_webhook ──────────────────────────────────────────
    // A API pública do n8n 2.8.x não expõe endpoint oficial para execução manual.
    // O endpoint interno /rest/workflows/run é instável entre versões.
    // Abordagem correta: Webhook Trigger no workflow + POST na URL gerada.
    server.tool(
        "execute_workflow_via_webhook",
        "Executa um workflow chamando seu Webhook Trigger via POST. O workflow precisa ter um nó Webhook configurado e ativo.",
        {
            webhookUrl: { type: "string", description: "URL completa do webhook (ex: https://seu-n8n.com/webhook/uuid)" },
            payload:    { type: "object", description: "Dados opcionais a enviar no body" }
        },
        async ({ webhookUrl, payload }) => {
            const controller = new AbortController();
            const timeout    = setTimeout(() => controller.abort(), 15000);
            try {
                const res  = await fetch(webhookUrl, {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify(payload ?? {}),
                    signal:  controller.signal
                });
                clearTimeout(timeout);
                const text = await res.text();
                let parsed;
                try { parsed = JSON.parse(text); } catch { parsed = text; }
                if (!res.ok) return { content: [{ type: "text", text: `Webhook erro (${res.status}): ${text}` }], isError: true };
                return { content: [
                    { type: "text", text: `Webhook chamado com sucesso (HTTP ${res.status}).` },
                    { type: "text", text: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2) }
                ]};
            } catch (err) {
                clearTimeout(timeout);
                return { content: [{ type: "text", text: `Erro ao chamar webhook: ${err.message}` }], isError: true };
            }
        }
    );

    // ── get_executions ────────────────────────────────────────────────────────
    server.tool(
        "get_executions",
        "Lista as execuções recentes de um workflow no n8n",
        {
            workflowId: { type: "string", description: "ID do workflow" },
            limit:      { type: "number", description: "Máximo de execuções a retornar (padrão: 10)" }
        },
        async ({ workflowId, limit = 10 }) => {
            try {
                const query = new URLSearchParams({ workflowId, limit: String(limit) }).toString();
                const data  = await n8nRequest(`/executions?${query}`);
                const list  = data?.data ?? data;
                const count = Array.isArray(list) ? list.length : "?";
                return { content: [
                    { type: "text", text: `${count} execução(ões) para o workflow ${workflowId}.` },
                    { type: "text", text: JSON.stringify(data, null, 2) }
                ]};
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    // ── get_node_types ────────────────────────────────────────────────────────
    server.tool(
        "get_node_types",
        "Lista os tipos de nós disponíveis no n8n. Use o filtro `group` para evitar payloads gigantes — valores comuns: 'trigger', 'transform', 'output', 'input', 'organization'.",
        { group: { type: "string", description: "Filtra por grupo. Opcional — sem filtro retorna todos." } },
        async ({ group }) => {
            try {
                const data  = await n8nRequest("/node-types");
                let   nodes = data?.data ?? data;
                if (group) {
                    nodes = nodes.filter(n =>
                        Array.isArray(n.group) ? n.group.includes(group) : n.group === group
                    );
                }
                const simplified = nodes.map(node => ({
                    name:        node.name,
                    displayName: node.displayName,
                    description: node.description,
                    version:     node.version ?? node.defaultVersion,
                    group:       node.group,
                    inputs:      node.inputs,
                    outputs:     node.outputs,
                    properties:  (node.properties ?? []).map(p => ({
                        name: p.name, displayName: p.displayName, type: p.type,
                        required: p.required ?? false, default: p.default, options: p.options ?? undefined
                    }))
                }));
                return { content: [
                    { type: "text", text: `${simplified.length} nó(s)${group ? ` no grupo "${group}"` : ""}.` },
                    { type: "text", text: JSON.stringify(simplified, null, 2) }
                ]};
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    // ── get_workflow_as_template ──────────────────────────────────────────────
    server.tool(
        "get_workflow_as_template",
        "Retorna um workflow existente formatado como template para ser adaptado e recriado.",
        { id: { type: "string", description: "ID do workflow a ser usado como template" } },
        async ({ id }) => {
            try {
                const data     = await n8nRequest(`/workflows/${id}`);
                const template = {
                    name:        `${data.name} (cópia)`,
                    nodes:       data.nodes.map(node => { const c = { ...node }; delete c.id; delete c.executeOnce; return c; }),
                    connections: data.connections,
                    settings:    data.settings ?? {}
                };
                return { content: [
                    { type: "text", text: `Template de "${data.name}". Use com create_workflow — ajuste name, nodes e connections antes de enviar.` },
                    { type: "text", text: JSON.stringify(template, null, 2) }
                ]};
            } catch (err) {
                return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
            }
        }
    );

    return server;
}

// ─── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Autenticação do servidor (opcional)
app.use((req, res, next) => {
    if (!SERVER_API_KEY) return next();
    if (req.headers["authorization"] !== `Bearer ${SERVER_API_KEY}`) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
});

// Health check — usado pelo Docker HEALTHCHECK e Portainer
app.get("/health", (_req, res) => {
    res.json({
        status:       "ok",
        sessions:     activeSessionCount(),
        sessionStore: redisClient ? "redis" : "memory",
        time:         new Date().toISOString()
    });
});

// ── POST /mcp ─────────────────────────────────────────────────────────────────
app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    // Sessão existente nesta réplica
    if (sessionId) {
        const session = await getSession(sessionId);
        if (session) {
            await session.transport.handleRequest(req, res, req.body);
            return;
        }

        // Sessão existe no Redis mas não nesta réplica — recria o transport
        if (redisClient && await sessionExists(sessionId)) {
            const raw         = await redisClient.get(`mcp:session:${sessionId}`);
            const { n8nUrl, n8nApiKey } = JSON.parse(raw);
            const n8nRequest  = makeN8nRequest(n8nUrl, n8nApiKey);
            const mcpServer   = createMcpServer(n8nRequest);
            const transport   = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });

            transport.onclose = async () => {
                await deleteSession(sessionId);
                console.log(`[session closed] ${sessionId} | ativas: ${activeSessionCount()}`);
            };

            await mcpServer.connect(transport);
            await saveSession(sessionId, n8nUrl, n8nApiKey, transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }
    }

    // Nova sessão: deve ser Initialize
    if (!isInitializeRequest(req.body)) {
        return res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Sessão não encontrada. Envie Initialize primeiro." },
            id: null
        });
    }

    let credentials;
    try {
        credentials = getCredentials(req);
    } catch (err) {
        return res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: err.message },
            id: null
        });
    }

    const { url: n8nUrl, apiKey: n8nApiKey } = credentials;
    const n8nRequest = makeN8nRequest(n8nUrl, n8nApiKey);
    const mcpServer  = createMcpServer(n8nRequest);
    const transport  = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });

    transport.onclose = async () => {
        const sid = transport.sessionId;
        if (sid) {
            await deleteSession(sid);
            console.log(`[session closed] ${sid} | ativas: ${activeSessionCount()}`);
        }
    };

    await mcpServer.connect(transport);

    const newSessionId = transport.sessionId;
    if (newSessionId) {
        await saveSession(newSessionId, n8nUrl, n8nApiKey, transport);
        console.log(`[session opened] ${newSessionId} | ativas: ${activeSessionCount()}`);
    }

    await transport.handleRequest(req, res, req.body);
});

// GET /mcp — não suportado
app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Use POST /mcp para iniciar uma sessão." });
});

// DELETE /mcp — encerra sessão explicitamente
app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId) return res.status(400).json({ error: "Header mcp-session-id obrigatório." });

    const session = await deleteSession(sessionId);
    if (session) {
        try { session.transport.close(); } catch {}
        console.log(`[session deleted] ${sessionId}`);
        return res.status(200).json({ ok: true });
    }
    res.status(404).json({ error: "Sessão não encontrada." });
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
    console.log(`╔══════════════════════════════════════════════╗`);
    console.log(`║         n8n MCP Server — StreamableHTTP      ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  POST  http://0.0.0.0:${PORT}/mcp               ║`);
    console.log(`║  GET   http://0.0.0.0:${PORT}/health            ║`);
    console.log(`╠══════════════════════════════════════════════╣`);
    console.log(`║  Session store : ${redisClient ? "Redis  " : "Memory "}                      ║`);
    console.log(`║  Multi-tenant  : headers x-n8n-url / x-n8n-api-key ║`);
    console.log(`║  Server auth   : ${SERVER_API_KEY ? "ON  (SERVER_API_KEY)" : "OFF               "} ║`);
    console.log(`╚══════════════════════════════════════════════╝`);
});
