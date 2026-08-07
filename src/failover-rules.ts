export interface FailoverRule {
  error_code: number;
  keywords: string[];
  duration_minutes: number;
  description: string;
}

// Sub2API 目前只支持“状态码相等 + 响应体包含关键词”。这些短词在
// billing、models、网关包装错误和真正的上游业务错误之间没有区分度，
// 一旦写入模板就可能把同一请求连续切穿整个候选池。
const unsafeGenericKeywords = new Map<string, string>([
  ["please retry later", "请使用完整的限流/容量错误短语"],
  ["retry later", "请使用完整的限流/容量错误短语"],
  ["please try again later", "请使用完整的限流/容量错误短语"],
  ["service temporarily unavailable", "请使用带 upstream 前缀的完整错误短语"],
  ["temporarily unavailable", "请使用带 upstream 前缀的完整错误短语"],
  ["upstream request failed", "仅允许挂在明确的 502/522/524 网关或连接故障上"],
  ["overloaded", "请使用完整的 provider 过载错误短语"],
  ["concurrency limit exceeded", "请使用 concurrency limit exceeded for account"],
  ["504", "请使用 error code: 504 或 status code: 504"],
  ["524", "请使用 error code: 524 或 status code: 524"],
  ["model_not_found", "模型不存在不得触发账号级切号"],
  ["model not found", "模型不存在不得触发账号级切号"],
]);

const statusScopedGenericKeywords = new Set(["upstream request failed"]);

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
      const reason = unsafeGenericKeywords.get(normalized);
      if (reason && !(statusScopedGenericKeywords.has(normalized) && [502, 522, 524].includes(rule.error_code))) {
        throw new Error(`unsafe failover keyword ${JSON.stringify(keyword)} on ${rule.error_code}: ${reason}`);
      }
    }
  }
}
