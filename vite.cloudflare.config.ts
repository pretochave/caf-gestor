import { defineConfig } from "vite";
import vinext from "vinext";
import { resolveCloudflareConfig } from "./scripts/cloudflare-config.mjs";

export default defineConfig(async () => {
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".cloudflare-runtime/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".cloudflare-runtime/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".cloudflare-runtime/registry";
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const config = resolveCloudflareConfig();
  return {
    build: { outDir: "dist-cloudflare" },
    // Keep optimized dependencies under node_modules so the framework's CommonJS
    // transform does not process already-converted optimizer output a second time.
    cacheDir: "node_modules/.vite-cloudflare",
    server: { host: "127.0.0.1", port: 5174 },
    environments: { client: { build: { outDir: "dist-cloudflare/client" } } },
    plugins: [
      vinext({
        rscOutDir: "dist-cloudflare/server",
        ssrOutDir: "dist-cloudflare/server/ssr",
        clientOutDir: "dist-cloudflare/client",
      }),
      cloudflare({
        configPath: "wrangler.jsonc",
        config(workerConfig) {
          // Mutate instead of returning arrays: the plugin merges returned arrays.
          workerConfig.d1_databases = config.d1_databases;
          if (config.account_id) workerConfig.account_id = config.account_id;
        },
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        persistState: { path: ".cloudflare-runtime/state" },
        inspectorPort: false,
      }),
    ],
  };
});
