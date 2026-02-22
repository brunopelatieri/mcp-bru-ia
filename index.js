import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fetch from "node-fetch";

const server = new McpServer({
    name: "n8n-mcp",
    version: "1.0.0"
});

const N8N_URL = process.env.N8N_URL;
if (!N8N_URL) {
    throw new Error("N8N_URL não definida");
}

const N8N_API_KEY = process.env.N8N_API_KEY;
if (!N8N_API_KEY) {
    throw new Error("N8N_API_KEY não definida");
}

async function n8nRequest(path, method = "GET", body) {
    const baseUrl = N8N_URL.endsWith("/") ? N8N_URL : `${N8N_URL}/`;
    const fullPath = path.startsWith("/") ? path.slice(1) : path;
    const url = `${baseUrl}api/v1/${fullPath}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const res = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${N8N_API_KEY}`
            },
            body: body ? JSON.stringify(body) : undefined,
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
}

/**
 * TOOL: List Workflows
 */
server.tool(
    "list_workflows",
    "Lista todos os workflows do n8n",
    {},
    async () => {
        try {
            const data = await n8nRequest("/workflows");
            const list = data?.data ?? data;
            const count = Array.isArray(list) ? list.length : "?";
            return {
                content: [
                    { type: "text", text: `${count} workflow(s) encontrado(s).` },
                    { type: "text", text: JSON.stringify(data, null, 2) }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Search Workflows
 */
server.tool(
    "search_workflows",
    "Busca workflows pelo nome (parcial ou completo, case-insensitive). Use antes de get_workflow quando não souber o ID exato.",
    {
        name: { type: "string", description: "Texto a buscar no nome do workflow" }
    },
    async ({ name }) => {
        try {
            const data = await n8nRequest("/workflows");
            const list = data?.data ?? data;

            if (!Array.isArray(list)) {
                throw new Error("Resposta inesperada da API ao listar workflows.");
            }

            const query = name.toLowerCase();
            const matches = list.filter(wf =>
                wf.name?.toLowerCase().includes(query)
            );

            return {
                content: [
                    {
                        type: "text",
                        text: matches.length > 0
                            ? `${matches.length} workflow(s) encontrado(s) com "${name}".`
                            : `Nenhum workflow encontrado com "${name}".`
                    },
                    {
                        type: "text",
                        text: JSON.stringify(
                            matches.map(wf => ({ id: wf.id, name: wf.name, active: wf.active })),
                            null,
                            2
                        )
                    }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Get Workflow by ID
 */
server.tool(
    "get_workflow",
    "Retorna os detalhes completos de um workflow pelo ID",
    {
        id: { type: "string", description: "ID do workflow no n8n" }
    },
    async ({ id }) => {
        try {
            const data = await n8nRequest(`/workflows/${id}`);
            return {
                content: [
                    { type: "text", text: `Workflow encontrado: "${data.name}" (ativo: ${data.active}).` },
                    { type: "text", text: JSON.stringify(data, null, 2) }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Create Workflow
 */
server.tool(
    "create_workflow",
    "Cria um novo workflow no n8n",
    {
        name: { type: "string", description: "Nome do workflow" },
        nodes: { type: "array", description: "Array de nós do workflow" },
        connections: { type: "object", description: "Objeto de conexões entre os nós" }
    },
    async ({ name, nodes, connections }) => {
        try {
            const data = await n8nRequest("/workflows", "POST", {
                name,
                nodes,
                connections,
                settings: {}
            });
            return {
                content: [
                    { type: "text", text: `Workflow criado com sucesso.` },
                    { type: "text", text: JSON.stringify({ id: data.id, name: data.name, active: data.active }, null, 2) }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Update Workflow
 */
server.tool(
    "update_workflow",
    "Atualiza um workflow existente no n8n. Faz GET antes do PUT para preservar staticData, settings, versionId e active flag. Todos os campos de atualização são opcionais.",
    {
        id: { type: "string", description: "ID do workflow a ser atualizado" },
        name: { type: "string", description: "Novo nome do workflow (opcional — mantém o atual se omitido)" },
        nodes: { type: "array", description: "Array atualizado de nós do workflow (opcional — mantém os atuais se omitido)" },
        connections: { type: "object", description: "Objeto atualizado de conexões entre os nós (opcional — mantém as atuais se omitido)" }
    },
    async ({ id, name, nodes, connections }) => {
        try {
            const existing = await n8nRequest(`/workflows/${id}`);

            const payload = {
                // id explícito — algumas versões da API do n8n validam que o body bate com a URL
                id: existing.id,
                // Campos críticos sempre preservados do workflow existente
                staticData: existing.staticData,
                settings: existing.settings,
                versionId: existing.versionId,
                active: existing.active,
                // Campos atualizáveis — usa o novo valor se fornecido, senão mantém o existente
                name: name ?? existing.name,
                nodes: nodes ?? existing.nodes,
                connections: connections ?? existing.connections
            };

            const updated = await n8nRequest(`/workflows/${id}`, "PUT", payload);

            return {
                content: [
                    { type: "text", text: `Workflow atualizado com sucesso.` },
                    { type: "text", text: JSON.stringify({ id: updated.id, name: updated.name, versionId: updated.versionId, active: updated.active }, null, 2) }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Activate / Deactivate Workflow
 */
server.tool(
    "activate_workflow",
    "Ativa ou desativa um workflow no n8n",
    {
        id: { type: "string", description: "ID do workflow" },
        active: { type: "boolean", description: "true para ativar, false para desativar" }
    },
    async ({ id, active }) => {
        try {
            const endpoint = active
                ? `/workflows/${id}/activate`
                : `/workflows/${id}/deactivate`;

            await n8nRequest(endpoint, "POST");

            return {
                content: [
                    {
                        type: "text",
                        text: active
                            ? `Workflow ${id} ativado com sucesso.`
                            : `Workflow ${id} desativado com sucesso.`
                    }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Delete Workflow
 */
server.tool(
    "delete_workflow",
    "Remove um workflow pelo ID",
    {
        id: { type: "string", description: "ID do workflow a ser removido" }
    },
    async ({ id }) => {
        try {
            await n8nRequest(`/workflows/${id}`, "DELETE");
            return {
                content: [
                    { type: "text", text: `Workflow ${id} removido com sucesso.` }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Execute Workflow via Webhook
 *
 * NOTA: A API pública do n8n (v2.8.x) não expõe endpoint oficial para execução
 * manual via REST. O endpoint interno `/rest/workflows/run` é não documentado
 * e instável entre versões — não deve ser usado em produção.
 *
 * A abordagem correta é usar um nó "Webhook Trigger" no workflow e chamar
 * sua URL diretamente. Esta tool faz exatamente isso.
 *
 * Para usar:
 *   1. Adicione um nó Webhook no workflow desejado
 *   2. Copie a URL gerada pelo nó
 *   3. Passe essa URL para esta tool
 */
server.tool(
    "execute_workflow_via_webhook",
    "Executa um workflow chamando seu Webhook Trigger via POST. O workflow precisa ter um nó Webhook configurado e ativo. Informe a URL completa do webhook.",
    {
        webhookUrl: {
            type: "string",
            description: "URL completa do webhook do workflow (ex: https://seu-n8n.com/webhook/uuid-aqui)"
        },
        payload: {
            type: "object",
            description: "Dados opcionais a enviar no body da requisição para o webhook"
        }
    },
    async ({ webhookUrl, payload }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
            const res = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload ?? {}),
                signal: controller.signal
            });

            clearTimeout(timeout);

            const text = await res.text();
            let parsed;
            try { parsed = JSON.parse(text); } catch { parsed = text; }

            if (!res.ok) {
                return {
                    content: [{ type: "text", text: `Webhook retornou erro (${res.status}): ${text}` }],
                    isError: true
                };
            }

            return {
                content: [
                    { type: "text", text: `Webhook chamado com sucesso (HTTP ${res.status}).` },
                    { type: "text", text: typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2) }
                ]
            };
        } catch (err) {
            clearTimeout(timeout);
            return { content: [{ type: "text", text: `Erro ao chamar webhook: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Get Executions
 */
server.tool(
    "get_executions",
    "Lista as execuções recentes de um workflow no n8n",
    {
        workflowId: { type: "string", description: "ID do workflow para filtrar execuções" },
        limit: { type: "number", description: "Número máximo de execuções a retornar (padrão: 10)" }
    },
    async ({ workflowId, limit = 10 }) => {
        try {
            const query = new URLSearchParams({ workflowId, limit: String(limit) }).toString();
            const data = await n8nRequest(`/executions?${query}`);
            const list = data?.data ?? data;
            const count = Array.isArray(list) ? list.length : "?";
            return {
                content: [
                    { type: "text", text: `${count} execução(ões) encontrada(s) para o workflow ${workflowId}.` },
                    { type: "text", text: JSON.stringify(data, null, 2) }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Get Node Types
 */
server.tool(
    "get_node_types",
    "Lista os tipos de nós disponíveis na instância do n8n. Use o filtro `group` para evitar payloads gigantes — valores comuns: 'trigger', 'transform', 'output', 'input', 'organization'. Sem filtro, retorna todos os grupos.",
    {
        group: { type: "string", description: "Filtra por grupo de nó (ex: 'trigger', 'transform', 'output', 'input'). Opcional — sem filtro retorna todos." }
    },
    async ({ group }) => {
        try {
            const data = await n8nRequest("/node-types");
            let nodes = data?.data ?? data;

            if (group) {
                nodes = nodes.filter(node =>
                    Array.isArray(node.group)
                        ? node.group.includes(group)
                        : node.group === group
                );
            }

            const simplified = nodes.map(node => ({
                name: node.name,
                displayName: node.displayName,
                description: node.description,
                version: node.version ?? node.defaultVersion,
                group: node.group,
                inputs: node.inputs,
                outputs: node.outputs,
                properties: (node.properties ?? []).map(p => ({
                    name: p.name,
                    displayName: p.displayName,
                    type: p.type,
                    required: p.required ?? false,
                    default: p.default,
                    options: p.options ?? undefined
                }))
            }));

            return {
                content: [
                    { type: "text", text: `${simplified.length} nó(s) encontrado(s)${group ? ` no grupo "${group}"` : ""}.` },
                    { type: "text", text: JSON.stringify(simplified, null, 2) }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * TOOL: Get Workflow as Template
 */
server.tool(
    "get_workflow_as_template",
    "Retorna um workflow existente formatado como template pronto para ser adaptado e recriado. Use como ponto de partida ao criar workflows similares.",
    {
        id: { type: "string", description: "ID do workflow a ser usado como template" }
    },
    async ({ id }) => {
        try {
            const data = await n8nRequest(`/workflows/${id}`);

            const template = {
                name: `${data.name} (cópia)`,
                nodes: data.nodes.map(node => {
                    const clean = { ...node };
                    delete clean.id;          // será gerado pelo n8n
                    delete clean.executeOnce;
                    return clean;
                }),
                connections: data.connections,
                settings: data.settings ?? {}
            };

            return {
                content: [
                    {
                        type: "text",
                        text: [
                            `Template baseado no workflow: "${data.name}"`,
                            `Use a estrutura no bloco abaixo com create_workflow.`,
                            `Ajuste name, nodes e connections antes de enviar — não reutilize diretamente.`
                        ].join("\n")
                    },
                    { type: "text", text: JSON.stringify(template, null, 2) }
                ]
            };
        } catch (err) {
            return { content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true };
        }
    }
);

/**
 * Bootstrap
 */
const transport = new StdioServerTransport();
await server.connect(transport);