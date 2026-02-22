/**
 * secrets-reader.js
 *
 * Docker Swarm injeta secrets como arquivos em /run/secrets/<nome>.
 * Este helper lê os valores dessas variáveis _FILE e os injeta na process.env,
 * permitindo que o index.js use process.env normalmente.
 *
 * Use no início do container ou importe antes de qualquer outra coisa.
 *
 * Variáveis suportadas:
 *   N8N_URL_FILE        → N8N_URL
 *   N8N_API_KEY_FILE    → N8N_API_KEY
 *   SERVER_API_KEY_FILE → SERVER_API_KEY
 *   REDIS_URL_FILE      → REDIS_URL
 */

import { readFileSync } from "node:fs";

const secretMappings = [
    ["N8N_URL_FILE",        "N8N_URL"],
    ["N8N_API_KEY_FILE",    "N8N_API_KEY"],
    ["SERVER_API_KEY_FILE", "SERVER_API_KEY"],
    ["REDIS_URL_FILE",      "REDIS_URL"]
];

for (const [fileEnv, targetEnv] of secretMappings) {
    const filePath = process.env[fileEnv];
    if (filePath && !process.env[targetEnv]) {
        try {
            process.env[targetEnv] = readFileSync(filePath, "utf8").trim();
            console.log(`[secrets] ${targetEnv} carregado de ${filePath}`);
        } catch (err) {
            console.warn(`[secrets] não foi possível ler ${filePath}: ${err.message}`);
        }
    }
}
