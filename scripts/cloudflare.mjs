import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { projectRoot, resolveCloudflareConfig, requireProductionConfig, ensureGeneratedMatches } from "./cloudflare-config.mjs";

const runtime = path.join(projectRoot, ".cloudflare-runtime");
const configPath = path.join(runtime, "wrangler.resolved.json");
const generatedConfig = path.join(projectRoot, "dist-cloudflare/server/wrangler.json");
const wrangler = path.join(projectRoot, "node_modules/wrangler/bin/wrangler.js");
function runWrangler(args, capture = false) {
  const options = { cwd: projectRoot, env: { ...process.env, CI: "true" }, ...(capture ? { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] } : { stdio: "inherit" }) };
  return execFileSync(process.execPath, [wrangler, ...args], options);
}
export async function prepareMigrations() {
  const journal = JSON.parse(await readFile(path.join(projectRoot, "drizzle/meta/_journal.json"), "utf8"));
  const target = path.join(runtime, "migrations");
  await mkdir(target, { recursive: true });
  for (const entry of journal.entries) {
    if (!/^\d{4}_[a-zA-Z0-9_-]+$/.test(entry.tag)) throw new Error("Nome de migração inválido no diário Drizzle.");
    const source = path.join(projectRoot, "drizzle", entry.tag + ".sql");
    const sql = await readFile(source, "utf8");
    if (!sql.trim()) throw new Error(`Migração vazia: ${entry.tag}`);
    const destination = path.join(target, entry.tag + ".sql");
    if (existsSync(destination) && await readFile(destination, "utf8") !== sql) throw new Error(`A migração ${entry.tag} foi alterada após ser preparada. Preserve o histórico e gere uma nova migração.`);
    await copyFile(source, destination);
  }
  return target;
}
async function resolvedConfig(config) {
  const migrations = await prepareMigrations();
  await mkdir(runtime, { recursive: true });
  const resolved = structuredClone(config);
  resolved.main = path.join(projectRoot, "worker.cloudflare.ts");
  resolved.assets.directory = path.join(projectRoot, "public");
  resolved.d1_databases.find(binding => binding.binding === "DB").migrations_dir = migrations;
  await writeFile(configPath, JSON.stringify(resolved, null, 2) + "\n");
  return configPath;
}
async function provision(config) {
  if (!config.account_id) throw new Error("Informe CLOUDFLARE_ACCOUNT_ID da sua conta antes de provisionar o banco.");
  const db = config.d1_databases.find(binding => binding.binding === "DB");
  const args = ["--config", await resolvedConfig(config)];
  let available = JSON.parse(runWrangler(["d1", "list", "--json", ...args], true));
  const existing = available.filter(item => item.name === db.database_name);
  if (existing.length > 1) throw new Error("Mais de um banco com esse nome foi encontrado. Selecione um identificador explicitamente.");
  if (!existing.length) {
    runWrangler(["d1", "create", db.database_name, "--update-config=false", ...args]);
    available = JSON.parse(runWrangler(["d1", "list", "--json", ...args], true));
  }
  const selected = available.find(item => item.name === db.database_name);
  if (!selected?.uuid) throw new Error("A Cloudflare não retornou um identificador para o banco criado.");
  const checked = resolveCloudflareConfig({ ...process.env, CLOUDFLARE_D1_DATABASE_ID: selected.uuid }, config);
  requireProductionConfig(checked);
  const source = JSON.parse(await readFile(path.join(projectRoot, "wrangler.jsonc"), "utf8"));
  source.account_id = checked.account_id;
  source.d1_databases.find(binding => binding.binding === "DB").database_id = selected.uuid;
  await writeFile(path.join(projectRoot, "wrangler.jsonc"), JSON.stringify(source, null, 2) + "\n");
  console.log(`Banco configurado: ${db.database_name} (${selected.uuid}). Conta: ${checked.account_id}.`);
}
export async function main(command, args = []) {
  process.chdir(projectRoot);
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= path.join(runtime, "logs");
  process.env.WRANGLER_REGISTRY_PATH ??= path.join(runtime, "dev-registry");
  process.env.MINIFLARE_REGISTRY_PATH ??= path.join(runtime, "registry");
  const config = resolveCloudflareConfig();
  if (command === "provision") return provision(config);
  if (command === "dev") {
    const { createServer } = await import("vite");
    const server = await createServer({ configFile: path.join(projectRoot, "vite.cloudflare.config.ts") });
    await server.listen(); server.printUrls();
    const stop = async () => { await server.close(); process.exit(0); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    return;
  }
  if (command === "build") {
    process.env.NODE_ENV ??= "production";
    // All Vite/RSC analysis passes belong to the same deployment.
    process.env.__VINEXT_SHARED_BUILD_ID ??= randomUUID();
    process.env.__VINEXT_SHARED_RSC_COMPATIBILITY_ID ??= randomUUID();
    process.env.__VINEXT_SHARED_REVALIDATE_SECRET ??= randomBytes(32).toString("hex");
    const { createBuilder } = await import("vite");
    const builder = await createBuilder({ configFile: path.join(projectRoot, "vite.cloudflare.config.ts"), mode: "production" });
    await builder.buildApp();
    // The Vite plugin copies this local-only file for built previews. Production
    // secrets belong to Worker bindings, not a portable deployment artifact.
    await rm(path.join(projectRoot, "dist-cloudflare/server/.dev.vars"), { force: true });
    if (!existsSync(generatedConfig)) throw new Error("A compilação não gerou a configuração do Worker independente.");
    console.log("Compilação independente concluída em dist-cloudflare/.");
    return;
  }
  if (["migrate", "deploy"].includes(command)) {
    const local = args.includes("--local");
    if (!local) requireProductionConfig(config);
    const selectedConfig = await resolvedConfig(config);
    if (command === "migrate") return runWrangler(["d1", "migrations", "apply", "DB", local ? "--local" : "--remote", "--config", selectedConfig, ...(local ? ["--persist-to", path.join(runtime, "state")] : [])]);
    if (local) throw new Error("Use dev:cloudflare para desenvolvimento local.");
    const generated = JSON.parse(await readFile(generatedConfig, "utf8"));
    ensureGeneratedMatches(config, generated);
    if (!args.includes("--dry-run")) runWrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", selectedConfig]);
    return runWrangler(["deploy", "--config", generatedConfig, ...(args.includes("--dry-run") ? ["--dry-run"] : [])]);
  }
  throw new Error("Use dev, build, provision, migrate [--local] ou deploy [--dry-run].");
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv[2], process.argv.slice(3)).catch(error => { console.error(error instanceof Error ? error.message : "A operação Cloudflare falhou."); process.exitCode = 1; });
}
