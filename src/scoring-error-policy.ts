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

// 业务侧余额或预扣额度不足不是上游账号质量证据。
// 该列表同时用于账号分和池级综合分，避免不同评分入口对同一错误产生不同归因。
export const nonScoreableBillingErrorPatterns = [
  "insufficient_balance",
  "insufficient account balance",
  "insufficient balance",
  "balance is insufficient",
  "insufficient_quota",
  "credit_balance_exhausted",
  "credit balance exhausted",
  "user balance is insufficient",
  "user quota is insufficient",
  "余额不足",
  "额度不足",
  "用户余额不足",
  "用户额度不足",
  "账户余额不足",
  "账号余额不足",
  "预扣费额度失败",
];

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export const modelRoutingPatternsSql = `ARRAY[${modelRoutingPatterns.map(sqlLiteral).join(", ")}]`;

export const stableUpstreamErrorPatternsSql = `ARRAY[${stableUpstreamErrorPatterns.map((pattern) => sqlLiteral(`%${pattern}%`)).join(", ")}]`;

export const nonScoreableBillingErrorPatternsSql = `ARRAY[${nonScoreableBillingErrorPatterns.map((pattern) => sqlLiteral(`%${pattern}%`)).join(", ")}]`;

// 同一余额短语可能来自客户账户或已选上游。明确的上游状态不能被关键词误排除。
export function explicitUpstreamErrorSql(alias: "o" | "source"): string {
  return `(${alias}.account_id IS NOT NULL
    AND LOWER(COALESCE(${alias}.error_phase, '')) = 'upstream'
    AND COALESCE(${alias}.upstream_status_code, 0) >= 400)`;
}

// 流已提交后的上游 5xx 可能被网关记录为 internal；只采用明确的上游状态证据。
// 调用方仍先排除客户输入、模型路由和账务错误。
export function attributedInternalUpstreamFailureSql(alias: "o" | "source"): string {
  return `(${alias}.account_id IS NOT NULL
    AND LOWER(COALESCE(${alias}.error_phase, '')) = 'internal'
    AND COALESCE(${alias}.upstream_status_code, 0) BETWEEN 500 AND 599)`;
}

// 语音服务不对外提供；按结构化模型名或入口识别，不按错误正文或用户提示词猜测。
export const audioModelPattern = "(^|[-_/])(audio|realtime|tts|stt|whisper|voice|speech|transcribe|transcription)([-_/]|$)";
const audioModelRegex = new RegExp(audioModelPattern, "iu");
const audioEndpointPattern = "(^|/)(audio|realtime|tts|stt|custom-voices|live)(/|$)";
const audioEndpointRegex = new RegExp(audioEndpointPattern, "iu");

export function isAudioRequest(models: unknown[], endpoint?: unknown): boolean {
  return models.some((model) => typeof model === "string" && audioModelRegex.test(model))
    || (typeof endpoint === "string" && audioEndpointRegex.test(endpoint.split("?")[0]!));
}

// 用模式已识别的 / 分隔模型字段，保留每个模型的首尾边界，只执行一次正则。
export function audioRequestSql(alias: string, includeEndpoint = false): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(alias)) throw new Error("invalid audio policy SQL alias");
  const models = [`CONCAT_WS('/', ${alias}.requested_model, ${alias}.model, ${alias}.upstream_model) ~* '${audioModelPattern}'`];
  if (includeEndpoint) models.push(`SPLIT_PART(COALESCE(${alias}.inbound_endpoint, ''), '?', 1) ~* '${audioEndpointPattern}'`);
  return `(${models.join(" OR ")})`;
}
