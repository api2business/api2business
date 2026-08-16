import type { OperationRequest } from "./contracts";
import type { ApplicationDispatcher } from "./dispatcher";
import type { AccountScoreService } from "./account-score-service";
import type { AccountImportService } from "./account-import-service";
import type { AccountLifecycleService } from "./account-lifecycle-service";
import type { OperationsService } from "./operations-service";
import type { TemporalGateway } from "./temporal-client";
import type { UpstreamManagementService } from "./upstream-management";
import type { UpstreamUsageResult } from "./upstream-usage";

export interface WorkerOperationServices {
  dispatcher: ApplicationDispatcher;
  scores: AccountScoreService;
  operations: OperationsService;
  imports: AccountImportService;
  lifecycle: AccountLifecycleService;
  upstreams: UpstreamManagementService;
  temporal: TemporalGateway | null;
}

export function createWorkerOperationExecutor(services: WorkerOperationServices) {
  const sampleUpstreamUsage = async () => {
    const result = await services.upstreams.usage([]);
    if (Array.isArray(result.results)) await services.operations.setUpstreamUsageCache(
      result.results as Array<Record<string, unknown>>, Number(result.apiAmountUsdTotal), true,
    );
    return { ok: true, sampled: result.targetCount, succeeded: result.succeeded, failed: result.failed };
  };

  return async (operation: OperationRequest): Promise<unknown> => {
    const command = operation.command;
    if (command.kind === "scores.refresh") return await services.scores.refresh();
    if (command.kind === "upstream.usage.sample") return await sampleUpstreamUsage();
    if (command.kind === "pool.quality.sample") return await services.operations.samplePoolQuality();
    if (command.kind === "bugteam.cost.sample") return await services.operations.sampleBugTeamCost();
    if (command.kind === "upstream.quota.sample") {
      const [oauth, usage, quality] = await Promise.allSettled([
        services.operations.sampleOAuthRuntime(), sampleUpstreamUsage(), services.operations.samplePoolQuality(),
      ]);
      const stages = { oauth, usage, quality };
      return { ok: Object.values(stages).every((stage) => stage.status === "fulfilled"), stages: Object.fromEntries(
        Object.entries(stages).map(([name, stage]) => [name, stage.status === "fulfilled"
          ? { ok: true, result: stage.value }
          : { ok: false, error: stage.reason instanceof Error ? stage.reason.message : String(stage.reason) }]),
      ) };
    }
    if (command.kind === "oauth.runtime.sample") return await services.operations.sampleOAuthRuntime();
    if (command.kind === "upstream.benchmark") return await services.operations.runUpstreamBenchmark(command.benchmarkRunId, command.accountId, command.model);
    if (command.kind === "account.idle-probe.run") return await services.operations.runIdleProbe(command.accountIds, command.rounds, {
      operationId: operation.operationId,
      triggerType: operation.operationId.includes(":idle-probe:") ? "automatic" : "manual",
    });
    if (command.kind === "account.idle-probe.reconcile") return await services.operations.reconcileIdleProbe(command.accountIds);
    if (command.kind === "priority.plan.create") return await services.operations.generatePriorityPlan(command.recentCallLimit, command.operator);
    if (command.kind === "priority.plan.manual-create") return await services.operations.createManualPriorityPlan(command.priorities, command.operator);
    if (command.kind === "priority.plan.confirm") return await services.operations.confirmPriorityPlan(command.planId, command.operator);
    if (command.kind === "priority.automation.run") {
      try {
        const result = await services.operations.runDueAutomation();
        const dispatch = await services.operations.priorityAutomationDispatchDelay();
        return { ...result, nextDelayMs: dispatch.delayMs, nextDelayReason: dispatch.reason };
      } catch (error) {
        await services.operations.deferPriorityAutomationAfterDispatchFailure(error).catch(() => null);
        throw error;
      }
    }
    if (command.kind === "account.import") {
      const job = await services.imports.runWorker(command.jobId);
      let postImportOAuthSample: Record<string, unknown> | null = null;
      if (job.state === "succeeded" && services.temporal) {
        try { postImportOAuthSample = await services.temporal.submit({ kind: "oauth.runtime.sample" }); }
        catch (error) { postImportOAuthSample = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      }
      return { ok: true, jobId: job.id, state: job.state, postImportOAuthSample, valuesPrinted: false };
    }
    if (command.kind === "account.lifecycle.detect") {
      const job = await services.lifecycle.runDetectWorker(command.jobId);
      return { ok: true, jobId: job.id, state: job.state, valuesPrinted: false };
    }
    if (command.kind === "account.lifecycle.settle") {
      const job = await services.lifecycle.runSettlementWorker(command.jobId, command.candidateIds);
      return { ok: true, jobId: job.id, state: job.state, valuesPrinted: false };
    }
    if (command.kind === "upstream.operation") {
      const pending = services.upstreams.claimOperation(command.operationId);
      if (!pending) throw new Error("上游 Temporal 作业缺少有效操作内容");
      let result: Record<string, unknown>;
      if (pending.action === "create") {
        result = await services.upstreams.create(pending.input);
        const createdAccount = result.account as { id?: unknown } | undefined;
        const accountId = Number(createdAccount?.id);
        if (result.skipDetection !== true && Number.isSafeInteger(accountId) && accountId > 0) {
          try {
            const detected = await services.upstreams.usage([accountId]);
            if (Array.isArray(detected.results)) {
              detected.rateSynchronization = await services.upstreams.synchronizeDetectedRates(
                detected.results as UpstreamUsageResult[],
                pending.input.rateWasSpecified ? {} : {
                  fallbackRateCnyPerApiUsd: services.upstreams.configuredUnprobedFallbackRate(),
                },
              );
              await services.operations.setUpstreamUsageCache(
                detected.results as Array<Record<string, unknown>>,
                Number.isFinite(Number(detected.apiAmountUsdTotal)) ? Number(detected.apiAmountUsdTotal) : null,
                false,
              );
            }
            result.detection = detected;
          } catch (error) {
            result.detection = { ok: false, accountId, error: error instanceof Error ? error.message : String(error) };
            const fallbackRate = services.upstreams.configuredUnprobedFallbackRate();
            let fallbackApplied = false;
            if (!pending.input.rateWasSpecified) {
              try {
                await services.upstreams.update(accountId, { rateCnyPerApiUsd: fallbackRate });
                fallbackApplied = true;
              } catch (fallbackError) {
                result.warnings = [
                  ...(Array.isArray(result.warnings) ? result.warnings : []),
                  `探测失败后的回退费率写入失败：${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
                ];
              }
            }
            result.warnings = [
              ...(Array.isArray(result.warnings) ? result.warnings : []),
              fallbackApplied
                ? `账号已创建，探测失败，已回退费率 ${fallbackRate} 元/刀；下一轮采样将重试探测`
                : "账号已创建，但额度或倍率探测失败；下一轮采样将重试探测",
            ];
          }
        }
      }
      else if (pending.action === "update") result = await services.upstreams.update(pending.input.id, pending.input);
      else if (pending.action === "recharge") result = await services.upstreams.recharge(pending.input.id, pending.input);
      else if (pending.action === "isolation") result = await services.upstreams.ensureProbeIsolation(pending.input.accountIds);
      else if (pending.action === "template") result = await services.upstreams.applyTemplate(pending.input.accountIds);
      else {
        result = await services.upstreams.usage(pending.input.accountIds);
        if (Array.isArray(result.results)) {
          result.rateSynchronization = await services.upstreams.synchronizeDetectedRates(result.results as UpstreamUsageResult[]);
          await services.operations.setUpstreamUsageCache(
            result.results as Array<Record<string, unknown>>,
            Number.isFinite(Number(result.apiAmountUsdTotal)) ? Number(result.apiAmountUsdTotal) : null,
            pending.input.accountIds.length === 0,
          );
          if (pending.input.accountIds.length === 0) {
            result.oauth = await services.operations.sampleOAuthRuntime();
            result.quality = await services.operations.samplePoolQuality();
          }
        }
      }
      services.upstreams.completeOperation(command.operationId);
      return result;
    }
    return await services.dispatcher.executeDirect(command);
  };
}
