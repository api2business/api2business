import type {
  Sub2ApiReadClient,
  Sub2ApiReadRequest,
  Sub2ApiReadResult,
  Sub2ApiReadStatus,
} from "./sub2api-read-executor";

export interface Sub2ApiReadTransport {
  sub2ApiRead<Row extends Record<string, unknown>>(
    request: Sub2ApiReadRequest,
  ): Promise<Sub2ApiReadResult<Row>>;
}

export class RemoteSub2ApiReadClient implements Sub2ApiReadClient {
  private latest: Sub2ApiReadStatus = {
    owner: "native-api",
    applicationName: "apistate-read-broker",
    connectionLimit: 1,
    queueDepth: 0,
    manualQueueDepth: 0,
    automaticQueueDepth: 0,
    active: false,
    activeKind: null,
    activeStartedAt: null,
    totalQueries: 0,
    deduplicatedQueries: 0,
    cacheHits: 0,
    queueTimeouts: 0,
    queryTimeouts: 0,
    connectionRecycles: 0,
    failedQueries: 0,
    maximumObservedDatabaseConcurrency: 1,
    lastCompletedAt: null,
    lastError: null,
  };

  constructor(private readonly transport: Sub2ApiReadTransport) {}

  async query<Row extends Record<string, unknown>>(
    request: Sub2ApiReadRequest,
  ): Promise<Sub2ApiReadResult<Row>> {
    const result = await this.transport.sub2ApiRead<Row>(request);
    this.latest = {
      ...this.latest,
      totalQueries: this.latest.totalQueries + 1,
      lastCompletedAt: result.queryCompletedAt,
      lastError: null,
    };
    return result;
  }

  status(): Sub2ApiReadStatus {
    return this.latest;
  }
}
