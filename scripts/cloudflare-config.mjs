import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const localDatabaseId = "00000000-0000-4000-8000-000000000000";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function resolveCloudflareConfig(environment = process.env, source) {
  const config = source ?? JSON.parse(readFileSync(path.join(projectRoot, "wrangler.jsonc"), "utf8").replace(/^\uFEFF/, ""));
  const result = structuredClone(config);
  const database = result.d1_databases?.find(binding => binding.binding === "DB");
  if (!database) throw new Error("O binding DB precisa estar declarado no wrangler.jsonc.");
  const account = environment.CLOUDFLARE_ACCOUNT_ID || result.account_id;
  if (account) {
    if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error("CLOUDFLARE_ACCOUNT_ID inválido.");
    result.account_id = account;
  }
  if (environment.CLOUDFLARE_D1_DATABASE_ID) database.database_id = environment.CLOUDFLARE_D1_DATABASE_ID;
  if (environment.CLOUDFLARE_D1_DATABASE_NAME) database.database_name = environment.CLOUDFLARE_D1_DATABASE_NAME;
  if (!uuid.test(database.database_id || "")) throw new Error("CLOUDFLARE_D1_DATABASE_ID precisa ser o UUID retornado pela Cloudflare.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(database.database_name || "")) throw new Error("Nome do banco D1 inválido.");
  return result;
}
export function requireProductionConfig(config) {
  const database = config.d1_databases.find(binding => binding.binding === "DB");
  if (!config.account_id || !/^[a-f0-9]{32}$/i.test(config.account_id)) throw new Error("Defina CLOUDFLARE_ACCOUNT_ID com a conta de destino antes de publicar.");
  if (!database?.database_id || database.database_id === localDatabaseId || !uuid.test(database.database_id)) throw new Error("Crie ou selecione o banco real com cloudflare:provision. O identificador local não pode ser publicado.");
  if (config.name !== "cafegestor") throw new Error("O Worker de destino deve se chamar cafegestor.");
  return config;
}
export function ensureGeneratedMatches(source, generated) {
  const expected = source.d1_databases.find(binding => binding.binding === "DB");
  const actual = generated.d1_databases?.find(binding => binding.binding === "DB");
  if (source.name !== generated.name || source.account_id !== generated.account_id || expected.database_id !== actual?.database_id) throw new Error("A compilação pertence a outro destino. Execute build:cloudflare novamente com a configuração atual.");
}
