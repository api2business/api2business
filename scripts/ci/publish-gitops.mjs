#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseAllDocuments } from "yaml";

const placeholders = {
  image: "__SUB2RANK_IMAGE_REF__",
  configBase64: "__SUB2RANK_CONFIG_BASE64__",
  configSha256: "__SUB2RANK_CONFIG_SHA256__",
  sourceCommit: "__SUB2RANK_SOURCE_COMMIT__",
};

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function required(value, path) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\n")) throw new Error(`${path} must be a non-empty single-line string`);
  return value;
}

function record(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value;
}

function safePath(value, path) {
  const result = required(value, path);
  if (result.startsWith("/") || result.split(/[\\/]/u).includes("..") || !/^[A-Za-z0-9._/-]+$/u.test(result)) throw new Error(`${path} must be a safe relative path`);
  return result;
}

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr || result.stdout || "command failed"}`.trim().slice(-2000);
    throw new Error(`${command} failed (${result.status}): ${detail}`);
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function replaceAllRequired(template, replacements) {
  let output = template;
  for (const [from, to] of replacements) {
    if (!output.includes(from)) throw new Error(`manifest template is missing ${from}`);
    output = output.split(from).join(to);
  }
  for (const placeholder of Object.values(placeholders)) {
    if (output.includes(placeholder)) throw new Error(`manifest template retained ${placeholder}`);
  }
  return output;
}

function validateManifest(manifest, expected) {
  const documents = parseAllDocuments(manifest);
  const errors = documents.flatMap((document) => document.errors);
  if (errors.length > 0) throw new Error(`rendered manifest is invalid YAML: ${errors[0].message}`);
  const objects = documents.map((document) => document.toJSON()).filter((value) => value !== null).map((value, index) => record(value, `manifest[${index}]`));
  const deployment = objects.find((item) => item.kind === "Deployment" && item.metadata?.name === "sub2rank");
  const service = objects.find((item) => item.kind === "Service" && item.metadata?.name === "sub2rank");
  const configMap = objects.find((item) => item.kind === "ConfigMap" && item.metadata?.name === "sub2rank-config");
  if (deployment === undefined || service === undefined || configMap === undefined) throw new Error("rendered manifest must contain the Sub2Rank Deployment, Service and ConfigMap");
  if (deployment.spec?.template?.spec?.containers?.[0]?.image !== expected.digestRef) throw new Error("rendered Deployment image is not the expected digest reference");
  if (deployment.spec?.template?.metadata?.annotations?.["unidesk.ai/source-commit"] !== expected.sourceCommit) throw new Error("rendered Deployment source commit annotation is incorrect");
  if (deployment.spec?.template?.metadata?.annotations?.["unidesk.ai/sub2rank-config-sha256"] !== expected.configSha256) throw new Error("rendered Deployment config SHA annotation is incorrect");
  if (configMap.binaryData?.["sub2rank.yaml"] !== expected.configBase64) throw new Error("rendered ConfigMap does not contain the exact source config");
}

function main() {
  const giteaToken = required(process.env.GITEA_TOKEN, "GITEA_TOKEN");
  const askPassPath = resolve(required(process.env.TMPDIR ?? "/tmp", "TMPDIR"), "apistate-git-askpass.sh");
  writeFileSync(askPassPath, `#!/bin/sh
case "$1" in
  *Username*) printf '%s' 'unidesk-admin' ;;
  *Password*) printf '%s' "$GITEA_TOKEN" ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  process.env.GIT_ASKPASS = askPassPath;
  process.env.GIT_TERMINAL_PROMPT = "0";
  const sourceRoot = resolve(required(option("--source-root"), "--source-root"));
  const sourceCommit = required(option("--source-commit"), "--source-commit");
  const configPath = safePath(required(option("--config-path"), "--config-path"), "--config-path");
  const metadataPath = resolve(required(option("--metadata"), "--metadata"));
  const templateB64 = required(option("--manifest-template-b64"), "--manifest-template-b64");
  const imageRepository = required(option("--image-repository"), "--image-repository");
  const readUrl = required(option("--gitops-read-url"), "--gitops-read-url");
  const writeUrl = required(option("--gitops-write-url"), "--gitops-write-url");
  const branch = required(option("--gitops-branch"), "--gitops-branch");
  const manifestPath = safePath(required(option("--manifest-path"), "--manifest-path"), "--manifest-path");
  const releaseStatePath = safePath(required(option("--release-state-path"), "--release-state-path"), "--release-state-path");
  const maxPushAttempts = Number(required(option("--max-push-attempts"), "--max-push-attempts"));
  const authorName = required(option("--author-name"), "--author-name");
  const authorEmail = required(option("--author-email"), "--author-email");
  const worktree = resolve(required(option("--worktree"), "--worktree"));
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("--source-commit must be a full lowercase Git SHA");
  if (!Number.isInteger(maxPushAttempts) || maxPushAttempts < 1 || maxPushAttempts > 5) throw new Error("--max-push-attempts must be an integer from 1 to 5");
  if (run("git", ["rev-parse", "HEAD"], sourceRoot).stdout.trim() !== sourceCommit) throw new Error("source checkout does not match --source-commit");

  const configText = readFileSync(resolve(sourceRoot, configPath), "utf8");
  const appConfig = record(Bun.YAML.parse(configText), configPath);
  if (appConfig.kind !== "Sub2Rank") throw new Error(`${configPath}.kind must be Sub2Rank`);
  const lottery = record(appConfig.lottery, `${configPath}.lottery`);
  const automaticCredit = record(lottery.automaticCredit, `${configPath}.lottery.automaticCredit`);
  if (typeof automaticCredit.enabled !== "boolean" || !new Set(["dry-run", "live"]).has(automaticCredit.mode)) throw new Error(`${configPath}.lottery.automaticCredit must declare enabled and mode`);
  const configBase64 = Buffer.from(configText, "utf8").toString("base64");
  const configSha256 = sha256(configText);

  const metadata = record(JSON.parse(readFileSync(metadataPath, "utf8")), metadataPath);
  const digest = required(metadata["containerimage.digest"], `${metadataPath}.containerimage.digest`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw new Error("BuildKit metadata digest is invalid");
  const digestRef = `${imageRepository}@${digest}`;
  const template = Buffer.from(templateB64, "base64").toString("utf8");
  const manifest = replaceAllRequired(template, [
    [placeholders.image, digestRef],
    [placeholders.configBase64, configBase64],
    [placeholders.configSha256, configSha256],
    [placeholders.sourceCommit, sourceCommit],
  ]);
  validateManifest(manifest, { digestRef, sourceCommit, configSha256, configBase64 });

  rmSync(worktree, { recursive: true, force: true });
  run("git", ["clone", "--no-checkout", readUrl, worktree], sourceRoot);
  const fetched = run("git", ["fetch", "origin", branch], worktree, true).status === 0;
  if (fetched) run("git", ["checkout", "-B", branch, `origin/${branch}`], worktree);
  else {
    run("git", ["checkout", "--orphan", branch], worktree);
    run("git", ["rm", "-rf", "."], worktree, true);
  }

  const targetPath = resolve(worktree, manifestPath);
  const statePath = resolve(worktree, releaseStatePath);
  if (!targetPath.startsWith(`${worktree}/`) || !statePath.startsWith(`${worktree}/`)) throw new Error("GitOps output path escaped the worktree");
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, manifest, "utf8");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    kind: "Sub2RankReleaseState",
    service: "sub2rank",
    sourceCommit,
    configSha256,
    digest,
    digestRef,
    manifestPath,
    automaticCredit: { enabled: automaticCredit.enabled, mode: automaticCredit.mode },
  }, null, 2)}\n`, "utf8");

  run("git", ["config", "user.name", authorName], worktree);
  run("git", ["config", "user.email", authorEmail], worktree);
  run("git", ["add", "--", manifestPath, releaseStatePath], worktree);
  const changed = run("git", ["diff", "--cached", "--quiet"], worktree, true).status !== 0;
  if (changed) run("git", ["commit", "-m", `sub2rank: deploy ${sourceCommit.slice(0, 12)}`], worktree);
  run("git", ["remote", "set-url", "origin", writeUrl], worktree);

  let pushAttempts = 0;
  if (changed) {
    let pushed = false;
    for (let attempt = 1; attempt <= maxPushAttempts; attempt += 1) {
      pushAttempts = attempt;
      if (run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], worktree, true).status === 0) {
        pushed = true;
        break;
      }
      run("git", ["fetch", "origin", branch], worktree);
      const rebase = run("git", ["rebase", `origin/${branch}`], worktree, true);
      if (rebase.status !== 0) {
        run("git", ["rebase", "--abort"], worktree, true);
        throw new Error(`GitOps rebase failed after push attempt ${attempt}`);
      }
    }
    if (!pushed) throw new Error(`GitOps push failed after ${maxPushAttempts} attempts`);
  }
  const gitopsCommit = run("git", ["rev-parse", "HEAD"], worktree).stdout.trim();
  const remoteHead = run("git", ["ls-remote", writeUrl, `refs/heads/${branch}`], worktree).stdout.trim().split(/\s+/u)[0] ?? "";
  if (remoteHead !== gitopsCommit) throw new Error("GitOps remote branch did not converge to the published commit");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    phase: "gitops-publish",
    status: "built",
    imageStatus: "built",
    sourceCommit,
    runtimeSourceCommit: sourceCommit,
    configSha256,
    automaticCredit: { enabled: automaticCredit.enabled, mode: automaticCredit.mode },
    digest,
    digestRef,
    gitopsCommit,
    changed,
    pushAttempts,
    valuesPrinted: false,
  })}\n`);
}

if (!process.execArgv.includes("--check")) main();
