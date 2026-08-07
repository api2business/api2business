export interface FailoverRule {
  error_code: number;
  keywords: string[];
  duration_minutes: number;
  description: string;
}

// Sub2API 原生模板是“状态码相等 + 响应体包含关键词”。旧版模板中的
// 通用临时故障词属于既有运行契约，不能因为本地校验而被静默删除。
// 唯一明确禁止的是模型不存在：它不是账号故障，不能触发账号级切号。
const forbiddenFailoverKeywords = new Set(["model_not_found", "model not found"]);

export function validateFailoverRules(rules: FailoverRule[]): void {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("failover rules must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (!Number.isSafeInteger(rule.error_code) || rule.error_code < 100 || rule.error_code > 599) {
      throw new Error(`failover rule ${index + 1} has an invalid error code`);
    }
    if (!Number.isSafeInteger(rule.duration_minutes) || rule.duration_minutes < 1 || rule.duration_minutes > 60) {
      throw new Error(`failover rule ${index + 1} has an invalid duration`);
    }
    if (!Array.isArray(rule.keywords) || rule.keywords.length === 0) {
      throw new Error(`failover rule ${index + 1} must have keywords`);
    }
    for (const keyword of rule.keywords) {
      const normalized = String(keyword).trim().toLowerCase();
      if (!normalized) throw new Error(`failover rule ${index + 1} contains an empty keyword`);
      const duplicateKey = `${rule.error_code}:${normalized}`;
      if (seen.has(duplicateKey)) throw new Error(`duplicate failover keyword: ${rule.error_code}/${keyword}`);
      seen.add(duplicateKey);
      if (forbiddenFailoverKeywords.has(normalized)) {
        throw new Error(`model-not-found must not trigger account failover: ${JSON.stringify(keyword)}`);
      }
    }
  }
}
