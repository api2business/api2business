import { defineConfig } from "vite";
import { loadConfig } from "./src/config";

const configPath = process.env.API2BUSINESS_CONFIG_PATH;
const runtimeId = process.env.API2BUSINESS_RUNTIME_ID;
if (!configPath) throw new Error("Vite requires API2BUSINESS_CONFIG_PATH");
if (!runtimeId) throw new Error("Vite requires API2BUSINESS_RUNTIME_ID");

const config = loadConfig(configPath);
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);

export default defineConfig({
  root: "static",
  server: {
    host: target.webListenHost,
    port: target.webListenPort,
    allowedHosts: target.webAllowedHosts,
    strictPort: true,
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/api": { target: target.webApiBaseUrl, changeOrigin: true },
      "/health": { target: target.webApiBaseUrl, changeOrigin: true },
    },
  },
});
