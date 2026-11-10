#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function snapshotProbeCache(snapshot) {
  const top = object(snapshot);
  const data = object(top.data);
  return object(object(data.probeHistory).cacheSummary ?? object(top.probeHistory).cacheSummary);
}

const baseUrlValue = argument("--base-url");
if (!baseUrlValue) fail("--base-url <absolute-http(s)-URL> is required");
const parsedBase = new URL(baseUrlValue);
if (!/^https?:$/u.test(parsedBase.protocol) || parsedBase.username || parsedBase.password) {
  fail("--base-url must be an absolute HTTP(S) URL without credentials");
}
const baseUrl = parsedBase.origin;
const expectedSnapshot = argument("--snapshot-json");
const checks = [];
const failures = [];

function check(name, ok, evidence) {
  checks.push({ name, ok, evidence });
  if (!ok) failures.push(name);
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow", headers: { "cache-control": "no-cache" } });
  const body = await response.text();
  return { response, body, url: response.url };
}

const pageUrl = `${baseUrl}/upstream-scheduling-v2`;
const page = await fetchText(pageUrl);
check("page-http", page.response.ok && /text\/html/iu.test(page.response.headers.get("content-type") ?? ""), `HTTP ${page.response.status} ${page.response.headers.get("content-type") ?? "unknown"}`);
check("probe-cache-summary", page.body.includes('id="v2-probe-cache-title"') && page.body.includes("probe-cache-overview"), "探活缓存命中摘要卡存在");
check("probe-cache-triggers", page.body.includes('data-trigger="automatic"') && page.body.includes('data-trigger="manual"'), "自动与手动探活分组存在");

const appMatch = page.body.match(/\/app\.js\?v=([0-9a-f]{16})/u);
check("frontend-revision", Boolean(appMatch), appMatch?.[1] ?? "missing /app.js?v=<revision>");
let app = null;
let module = null;
let moduleRevision = null;
if (appMatch) {
  app = await fetchText(`${baseUrl}/app.js?v=${appMatch[1]}`);
  check("app-http", app.response.ok, `HTTP ${app.response.status}`);
  check("app-is-current", app.body.includes(`upstream-scheduling-v2.js?v=${appMatch[1]}`), `import revision ${appMatch[1]}`);
  const moduleMatch = app.body.match(/\/upstream-scheduling-v2\.js\?v=([0-9a-f]{16})/u);
  check("page-module-revision", Boolean(moduleMatch), moduleMatch?.[1] ?? "missing upstream-scheduling-v2.js revision");
  if (moduleMatch) {
    moduleRevision = moduleMatch[1];
    module = await fetchText(`${baseUrl}/upstream-scheduling-v2.js?v=${moduleMatch[1]}`);
    check("page-module-http", module.response.ok, `HTTP ${module.response.status}`);
    check("page-module-cache-ui", module.body.includes("renderProbeCacheSummary") && module.body.includes("缓存命中") && module.body.includes("data-probe-detail-row"), "缓存摘要和逐账号明细渲染逻辑存在");
  }
}

let snapshot = null;
let cache = null;
if (expectedSnapshot) {
  snapshot = JSON.parse(readFileSync(expectedSnapshot, "utf8"));
  cache = object(object(snapshot).cache);
  const probeCache = snapshotProbeCache(snapshot);
  check("snapshot-cache-state", ["hit", "stale", "refreshed"].includes(String(cache.state ?? "")), `cache.state=${cache.state ?? "missing"}`);
  check("snapshot-cache-complete", cache.complete === true, `cache.complete=${String(cache.complete)}`);
  check("snapshot-probe-cache-summary", Object.keys(probeCache).length > 0, Object.keys(probeCache).length > 0 ? "data.probeHistory.cacheSummary 存在" : "data.probeHistory.cacheSummary 缺失");
}

const result = {
  ok: failures.length === 0,
  baseUrl,
  frontendRevision: appMatch?.[1] ?? null,
  pageModuleRevision: moduleRevision,
  assets: {
    page: { status: page.response.status, bytes: Buffer.byteLength(page.body), sha256: sha256(page.body) },
    app: app ? { status: app.response.status, bytes: Buffer.byteLength(app.body), sha256: sha256(app.body) } : null,
    pageModule: module ? { status: module.response.status, bytes: Buffer.byteLength(module.body), sha256: sha256(module.body) } : null,
  },
  cache: cache ? { state: cache.state ?? null, complete: cache.complete ?? null, capturedAt: cache.capturedAt ?? null } : null,
  checks,
  failures,
  valuesPrinted: false,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
