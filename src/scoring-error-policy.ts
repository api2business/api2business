const modelRoutingPatterns = [
  "%model_not_found%",
  "%model not found%",
  "%model_no_found%",
  "%model no found%",
  "%moddel_no_found%",
  "%model does not exist%",
  "%model doesn't exist%",
  "%unknown model%",
  "%no such model%",
  "%unsupported model%",
  "%not supported by any configured account%",
  "%no available channel for model%",
];

export const stableUpstreamErrorPatterns = [
  "upstream service temporarily unavailable",
  "upstream request failed",
  "bad gateway",
  "gateway timeout",
  "error code: 502",
  "error code: 503",
  "error code: 504",
  "error code: 524",
  "we're currently experiencing high demand",
  "we are currently experiencing high demand",
];

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export const modelRoutingPatternsSql = `ARRAY[${modelRoutingPatterns.map(sqlLiteral).join(", ")}]`;

export const stableUpstreamErrorPatternsSql = `ARRAY[${stableUpstreamErrorPatterns.map((pattern) => sqlLiteral(`%${pattern}%`)).join(", ")}]`;

// 流已提交后的上游 5xx 可能被网关记录为 internal；只采用明确的上游状态证据。
// 调用方仍先排除客户输入、模型路由和账务错误。
export function attributedInternalUpstreamFailureSql(alias: "o" | "source"): string {
  return `(${alias}.account_id IS NOT NULL
    AND LOWER(COALESCE(${alias}.error_phase, '')) = 'internal'
    AND COALESCE(${alias}.upstream_status_code, 0) BETWEEN 500 AND 599)`;
}
