export interface ModelSyncCanonicalModel {
  aliases: string[];
}

export interface ModelSyncPolicy {
  automaticDisabledPlatforms: string[];
  canonicalModels: Record<string, ModelSyncCanonicalModel>;
}

export interface ModelSyncScopePolicy {
  enabled: boolean;
  platform: string;
  features: {
    modelSyncAutomation: boolean;
  };
}

export interface ModelSyncSchedulingPolicy {
  modelSyncPolicy?: ModelSyncPolicy;
  scopes: Record<string, ModelSyncScopePolicy>;
}

function normalizedPlatform(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function automaticModelSyncDisabledByPolicy(
  platform: string | null | undefined,
  policy: ModelSyncPolicy | null | undefined,
): boolean {
  if (!policy) return false;
  const normalized = normalizedPlatform(platform);
  return policy.automaticDisabledPlatforms.some((disabled) => normalizedPlatform(disabled) === normalized);
}

export function automaticModelSyncAllowed(
  scope: ModelSyncScopePolicy | null | undefined,
  policy: ModelSyncPolicy | null | undefined,
): boolean {
  if (!scope?.enabled || scope.features.modelSyncAutomation !== true || !policy) return false;
  return !automaticModelSyncDisabledByPolicy(scope.platform, policy);
}

export function automaticModelSyncScopeNames(scheduling: ModelSyncSchedulingPolicy | null | undefined): string[] {
  if (!scheduling) return [];
  return Object.entries(scheduling.scopes)
    .filter(([, scope]) => automaticModelSyncAllowed(scope, scheduling.modelSyncPolicy))
    .map(([name]) => name);
}

function modelBasename(model: string): string {
  return model.split("/").at(-1) ?? model;
}

function familyForModel(model: string, policy: ModelSyncPolicy): string | null {
  const basename = modelBasename(model);
  for (const [canonical, definition] of Object.entries(policy.canonicalModels)) {
    if (model === canonical || basename === canonical) return canonical;
    if (definition.aliases.some((alias) => model === alias || basename === alias)) return canonical;
  }
  return null;
}

function preferredCanonicalValue(canonical: string, candidates: string[], platform: string): string {
  const exact = candidates.find((model) => model === canonical);
  const prefixed = candidates.find((model) => model !== canonical && modelBasename(model) === canonical);
  const fallback = candidates.find((model) => model.toLowerCase() === `${canonical}-1017`);
  const aliases = candidates.filter((model) => model !== exact && model !== prefixed && model !== fallback);
  if (platform === "command_code" || platform === "command-code" || platform === "commandcode") {
    return prefixed ?? exact ?? fallback ?? aliases[0] ?? canonical;
  }
  return exact ?? prefixed ?? fallback ?? aliases[0] ?? canonical;
}

export function normalizeModelMapping(
  models: string[],
  platform: string | null | undefined,
  policy: ModelSyncPolicy | null | undefined,
): Record<string, string> {
  const orderedModels = [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  if (!policy) return Object.fromEntries(orderedModels.map((model) => [model, model]));

  const familyCandidates = new Map<string, string[]>();
  const mapping: Record<string, string> = {};
  for (const model of orderedModels) {
    const canonical = familyForModel(model, policy);
    if (!canonical) {
      mapping[model] = model;
      continue;
    }
    familyCandidates.set(canonical, [...(familyCandidates.get(canonical) ?? []), model]);
  }
  for (const [canonical, candidates] of familyCandidates) {
    mapping[canonical] = preferredCanonicalValue(canonical, candidates, normalizedPlatform(platform));
  }
  return mapping;
}
