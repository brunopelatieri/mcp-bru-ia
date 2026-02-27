/**
 * secrets-reader.js
 *
 * Docker Swarm injeta secrets como arquivos em /run/secrets/<nome>.
 * Lê as variáveis _FILE e injeta os valores na process.env.
 * Falhas são logadas como warning — nunca derrubam o processo.
 */

import { readFileSync, existsSync } from "node:fs";

const secretMappings = [
    ["N8N_URL_FILE",        "N8N_URL"],
    ["N8N_API_KEY_FILE",    "N8N_API_KEY"],
    ["SERVER_API_KEY_FILE", "SERVER_API_KEY"],
    ["REDIS_URL_FILE",      "REDIS_URL"]
];

for (const [fileEnv, targetEnv] of secretMappings) {
    const filePath = process.env[fileEnv];

    if (!filePath) continue;                          // var _FILE não definida, ignora
    if (process.env[targetEnv]) continue;             // valor já definido na env, não sobrescreve

    if (!existsSync(filePath)) {
        console.warn(`[secrets] arquivo não encontrado: ${filePath} (${fileEnv} definida mas secret não montada)`);
        continue;
    }

    try {
        const value = readFileSync(filePath, "utf8").trim();
        if (!value) {
            console.warn(`[secrets] arquivo vazio: ${filePath}`);
            continue;
        }
        process.env[targetEnv] = value;
        console.log(`[secrets] ${targetEnv} carregado de ${filePath}`);
    } catch (err) {
        console.warn(`[secrets] erro ao ler ${filePath}: ${err.message}`);
    }
}