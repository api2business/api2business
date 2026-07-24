import type { AppCommand, OperationRequest } from "./contracts";
import type { AccountScoreService } from "./account-score-service";
import type { LotteryService } from "./lottery-service";
import type { TemporalGateway } from "./temporal-client";
import { usesWorkflow } from "./contracts";

export interface DispatcherServices {
  lottery: LotteryService;
  scores: AccountScoreService;
}

export async function dispatchDirect(services: DispatcherServices, command: AppCommand): Promise<unknown> {
  if (command.kind === "backend.check") return await services.lottery.status(true);
  if (command.kind === "scores.get") return services.scores.state();
  if (command.kind === "scores.refresh") return await services.scores.refresh();
  if (command.kind === "scores.rank") return await services.scores.rank(command.recentCallLimit, command.accountSelector, command.groupSelector);
  if (command.kind === "ranking.get") return await services.lottery.ranking();
  if (command.kind === "lottery.publicState") return await services.lottery.publicState();
  if (command.kind === "lottery.publicDraw") return await services.lottery.publicDraw();
  if (command.kind === "lottery.status") return await services.lottery.status(false);
  if (command.kind === "lottery.draw") return { ok: true, record: await services.lottery.draw() };
  if (command.kind === "lottery.reset") return services.lottery.reset(command.draws, command.includeRecords);
  if (command.kind === "records.list") return { ok: true, records: services.lottery.listRecords(command.limit) };
  if (command.kind === "records.delete") return services.lottery.deleteRecord(command.id);
  if (command.kind === "credit.test") return await services.lottery.creditTest(command.execute);
  const exhaustive: never = command;
  throw new Error(`unsupported command ${JSON.stringify(exhaustive)}`);
}

export class ApplicationDispatcher {
  constructor(
    private readonly services: DispatcherServices,
    private readonly temporal: TemporalGateway | null,
  ) {}

  async dispatch(command: AppCommand): Promise<unknown> {
    if (!usesWorkflow(command)) return await dispatchDirect(this.services, command);
    if (!this.temporal) throw new Error(`command ${command.kind} requires Temporal`);
    return await this.temporal.execute(command);
  }

  async submit(command: AppCommand): Promise<unknown> {
    if (!usesWorkflow(command)) throw new Error(`command ${command.kind} does not use Temporal`);
    if (!this.temporal) throw new Error(`command ${command.kind} requires Temporal`);
    return await this.temporal.submit(command);
  }

  async workflowStatus(workflowId: string): Promise<unknown> {
    if (!this.temporal) throw new Error("workflow status requires Temporal");
    return await this.temporal.status(workflowId);
  }
}

export function createActivities(services: DispatcherServices): { executeOperation(request: OperationRequest): Promise<unknown> } {
  return {
    executeOperation: async (request) => await dispatchDirect(services, request.command),
  };
}
