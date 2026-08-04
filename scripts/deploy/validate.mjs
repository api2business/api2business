#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

const requiredFiles = ["Dockerfile", "compose.yaml", "deploy/kubernetes/manifest.yaml", "docs/reference/deployment.md", "skills/api2business/SKILL.md"];
for (const path of requiredFiles) readFileSync(path, "utf8");

const manifest = readFileSync("deploy/kubernetes/manifest.yaml", "utf8")
  .replaceAll("__API2BUSINESS_IMAGE_REF__", "registry.example.com/api2business@sha256:" + "0".repeat(64))
  .replaceAll("__API2BUSINESS_SOURCE_COMMIT__", "0".repeat(40))
  .replaceAll("__API2BUSINESS_CONFIG_SHA256__", "0".repeat(64))
  .replaceAll("__API2BUSINESS_CONFIG_BASE64__", Buffer.from("version: 1\nkind: Api2Business\n").toString("base64"));
const documents = parseAllDocuments(manifest);
const errors = documents.flatMap((document) => document.errors);
if (errors.length > 0) throw new Error(`invalid Kubernetes manifest: ${errors[0].message}`);

const trackedText = requiredFiles.map((path) => readFileSync(path, "utf8")).join("\n");
for (const forbidden of [/unidesk/iu, /pipelinesascode/iu, /api[_-]?key\s*[:=]\s*["']?sk-/iu]) {
  if (forbidden.test(trackedText)) throw new Error(`deployment assets contain forbidden pattern ${forbidden}`);
}
process.stdout.write(JSON.stringify({ ok: true, files: requiredFiles.length, valuesPrinted: false }) + "\n");
