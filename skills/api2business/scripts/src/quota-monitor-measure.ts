import type { AdminHttpClient } from '../../../../src/admin-http-client';

type Row = Record<string, any>;

// 使用正式 HTTP client 测量页面数据依赖，不输出认证材料或账号详情。
export async function measureQuotaMonitor(client: AdminHttpClient, mode: string, rounds: number) {
  if (!['source', 'snapshot'].includes(mode)) throw new Error('--mode must be source or snapshot');
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('--rounds must be 1..10');
  const measurements: Row[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    const requests: Row[] = [];
    async function timed(name: string, read: () => Promise<Row>) {
      const at = performance.now();
      try {
        const result = await read();
        if (result.ok !== true) throw new Error(String(result.error ?? 'read failed'));
        requests.push({ name, elapsedMs: Math.round(performance.now() - at), queryDurationMs: result.queryDurationMs, queueDurationMs: result.queueDurationMs });
        return result;
      } catch (error) {
        requests.push({ name, elapsedMs: Math.round(performance.now() - at), error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    try {
      let accountCount = 0;
      if (mode === 'snapshot') {
        const result = await timed('snapshot', () => client.quotaMonitorSnapshot());
        accountCount = result.accounts?.length ?? 0;
      } else {
        const first = await timed('accounts:1', () => client.upstreams(1, null));
        const pages = await Promise.all(Array.from({ length: Math.min(Number(first.totalPages ?? 1), 20) - 1 }, (_, i) => timed(`accounts:${i + 2}`, () => client.upstreams(i + 2, null))));
        const accounts = [first, ...pages].flatMap((page) => page.accounts ?? []);
        accountCount = accounts.length;
        const chunks: number[][] = [];
        for (let i = 0; i < accounts.length; i += 100) chunks.push(accounts.slice(i, i + 100).map((row: Row) => Number(row.id)));
        await Promise.all([
          ...chunks.map((ids, i) => timed(`usage-cache:${i}`, () => client.upstreamUsageCacheRead(ids))),
          ...chunks.map((ids, i) => timed(`usage24h:${i}`, () => client.quotaMonitorUsage(ids))),
          timed('summary', () => client.upstreamQuotaSummary()),
        ]);
      }
      measurements.push({ round: round + 1, ok: true, elapsedMs: Math.round(performance.now() - started), accountCount, requestCount: requests.length, requests });
    } catch (error) {
      measurements.push({ round: round + 1, ok: false, elapsedMs: Math.round(performance.now() - started), requests, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: measurements.every((row) => row.ok), mode, measurements, valuesPrinted: false };
}
