export interface FailoverRule {
  error_code: number;
  keywords: string[];
  duration_minutes: number;
  description: string;
}

// Sub2API 原生模板是“状态码相等 + 响应体包含关键词”。旧版模板中的
// 通用临时故障词属于既有运行契约，不能因为本地校验而被静默删除。
// 模型不存在或分组不支持模型不是账号故障，不能触发账号级切号。
// 容量不足（例如 selected model is at capacity）仍属于可恢复的临时故障。
const forbiddenFailoverKeywordFragments = [
  "model_not_found",
  "model not found",
  "model_no_found",
  "moddel_no_found",
  "model does not exist",
  "unsupported model",
  "model is not supported",
  "not supported by any configured account",
  "no available channel for model",
];

export function validateFailoverRules(rules: FailoverRule[]): void {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error("failover rules must be a non-empty array");
  }
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
      if (forbiddenFailoverKeywordFragments.some((fragment) => normalized.includes(fragment))) {
        throw new Error(`unsupported model must not trigger account failover: ${JSON.stringify(keyword)}`);
      }
    }
  }
}
