import { defineConfig, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./src/config";

const configPath = process.env.API2BUSINESS_CONFIG_PATH;
const runtimeId = process.env.API2BUSINESS_RUNTIME_ID;
if (!configPath) throw new Error("Vite requires API2BUSINESS_CONFIG_PATH");
if (!runtimeId) throw new Error("Vite requires API2BUSINESS_RUNTIME_ID");

const config = loadConfig(configPath);
const target = config.runtime.serverTargets[runtimeId];
if (!target) throw new Error(`runtime.serverTargets.${runtimeId} does not exist`);

// This web server is the authenticated production entry, not a build artifact CDN.
// Vite otherwise marks query-versioned modules immutable, which can keep old UI code
// in a browser or reverse proxy after a deployment.
const frontendNoStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "Surrogate-Control": "no-store",
};

const frontendAssetNames = new Set([
  "app.js", "styles.css", "history-chart.js", "ledger-pages.js",
  "score-display-freshness.js", "upstream-quality-assets.js", "bugteam-cost.js",
]);
const frontendRevision = createHash("sha256")
    .update(readdirSync(resolve(process.cwd(), "static"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".html") || frontendAssetNames.has(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.name}\0${readFileSync(join(resolve(process.cwd(), "static"), entry.name))}`)
    .join("\0"))
  .digest("hex")
  .slice(0, 16);

const frontendRevisionPlugin = {
  name: "api2business-frontend-revision",
  transformIndexHtml(html: string) {
    return html.replace(/((?:\/|\.\/)(?:app|styles|history-chart|ledger-pages|score-display-freshness|upstream-quality-assets|bugteam-cost)\.js|(?:\/|\.\/)styles\.css)\?v=[^"'&\s]+/gu, `$1?v=${frontendRevision}`);
  },
  transform(code: string, id: string) {
    if (!id.endsWith(".js")) return null;
    return code.replace(/((?:\.\/|\/)(?:history-chart|ledger-pages|score-display-freshness|upstream-quality-assets|bugteam-cost)\.js)\?v=[^"']+/gu, `$1?v=${frontendRevision}`);
  },
};

const pageRoutePlugin: Plugin = {
  name: "api2business-page-routes",
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      const [pathname, query = ""] = String(request.url ?? "").split("?", 2);
      if (pathname === "/upstream-scheduling-v2") request.url = `/upstream-scheduling-v2.html${query ? `?${query}` : ""}`;
      next();
    });
  },
};

export default defineConfig({
  plugins: [frontendRevisionPlugin, pageRoutePlugin],
  root: "static",
  server: {
    headers: frontendNoStoreHeaders,
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
  preview: { headers: frontendNoStoreHeaders },
});
