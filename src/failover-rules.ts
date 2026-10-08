export interface FailoverRule {
  error_code: number;
  keywords: string[];
  duration_minutes: number;
  description: string;
}

// Sub2API 原生规则按状态码与响应体关键词匹配。
// 预期模型能力缺失可以声明为上游切号规则；全局路由失败不进入账号模板。
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
    }
  }
}
