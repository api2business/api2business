package temporalworker

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

type OperationRequest struct {
	OperationID string         `json:"operationId"`
	Command     map[string]any `json:"command"`
}
type OperationWorkflowInput struct {
	Operation                   OperationRequest `json:"operation"`
	ActivityStartToCloseTimeout string           `json:"activityStartToCloseTimeout"`
	MaximumAttempts             int32            `json:"maximumAttempts"`
}
type ScheduleInput struct {
	IntervalMS                  int    `json:"intervalMs"`
	RoundTimeoutMS              int    `json:"roundTimeoutMs"`
	ActivityStartToCloseTimeout string `json:"activityStartToCloseTimeout"`
	MaximumAttempts             int32  `json:"maximumAttempts"`
}
type PriorityAutomationRunResult struct {
	NextDelayMS int `json:"nextDelayMs"`
}

type ApiKeyCutoffWorkflowResult struct {
	OK                  bool   `json:"ok"`
	AccountIDs          []any  `json:"accountIds"`
	DisabledCount       int    `json:"disabledCount"`
	VerifiedCount       int    `json:"verifiedCount"`
	RestoredCount       int    `json:"restoredCount"`
	SkippedCount        int    `json:"skippedCount"`
	AvailableOAuthCount int    `json:"availableOAuthCount"`
	Disable             any    `json:"disable"`
	Guard               any    `json:"guard"`
	Restore             any    `json:"restore"`
	RestoreReason       string `json:"restoreReason"`
}

func priorityAutomationDelayMilliseconds(result PriorityAutomationRunResult, fallback int) int {
	delay := result.NextDelayMS
	if delay <= 0 {
		delay = fallback
	}
	if delay < minimumPriorityAutomationPollMilliseconds {
		delay = minimumPriorityAutomationPollMilliseconds
	}
	return delay
}

func activityOptions(timeout string, attempts int32) workflow.ActivityOptions {
	duration, err := time.ParseDuration(timeout)
	if err != nil || duration <= 0 {
		duration = 10 * time.Minute
	}
	if attempts < 1 {
		attempts = 1
	}
	return workflow.ActivityOptions{StartToCloseTimeout: duration, RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: attempts}, WaitForCancellation: true}
}

func scheduledActivityOptions(timeout string, attempts int32) workflow.ActivityOptions {
	options := activityOptions(timeout, attempts)
	options.ScheduleToCloseTimeout = options.StartToCloseTimeout
	return options
}

func OperationWorkflow(ctx workflow.Context, input OperationWorkflowInput) (any, error) {
	ctx = workflow.WithActivityOptions(ctx, activityOptions(input.ActivityStartToCloseTimeout, input.MaximumAttempts))
	var result any
	err := workflow.ExecuteActivity(ctx, "executeOperation", input.Operation).Get(ctx, &result)
	return result, err
}

func ApiKeyCutoffWorkflow(ctx workflow.Context, input OperationWorkflowInput) (any, error) {
	ctx = workflow.WithActivityOptions(ctx, activityOptions(input.ActivityStartToCloseTimeout, input.MaximumAttempts))
	command := input.Operation.Command
	cutoffOperationID, _ := command["operationId"].(string)
	if cutoffOperationID == "" {
		cutoffOperationID = input.Operation.OperationID
	}
	command["phase"] = "disable"
	disableRequest := OperationRequest{OperationID: input.Operation.OperationID + ":disable", Command: command}
	var disableResult map[string]any
	if err := workflow.ExecuteActivity(ctx, "executeOperation", disableRequest).Get(ctx, &disableResult); err != nil {
		return nil, err
	}

	durationSeconds, ok := command["durationSeconds"].(float64)
	if !ok || durationSeconds < 1 {
		if integer, integerOK := command["durationSeconds"].(int); integerOK {
			durationSeconds = float64(integer)
		}
	}
	if durationSeconds < 1 {
		return nil, fmt.Errorf("invalid API Key cutoff duration")
	}
	deadline := workflow.Now(ctx).Add(time.Duration(durationSeconds) * time.Second)
	restoreNow := false
	signalChannel := workflow.GetSignalChannel(ctx, "restore-now")
	var signalPayload any
	if signalChannel.ReceiveAsync(&signalPayload) {
		restoreNow = true
	}
	var guardResult map[string]any
	restoreReason := "到期自动恢复"
	for workflow.Now(ctx).Before(deadline) && !restoreNow {
		guardRequest := OperationRequest{OperationID: input.Operation.OperationID + ":guard", Command: map[string]any{
			"kind": "upstream.apikey.cutoff", "phase": "guard", "operationId": cutoffOperationID, "durationSeconds": durationSeconds,
			"trigger": command["trigger"],
		}}
		if err := workflow.ExecuteActivity(ctx, "executeOperation", guardRequest).Get(ctx, &guardResult); err != nil {
			return nil, err
		}
		shouldRestore, _ := guardResult["shouldRestore"].(bool)
		if shouldRestore {
			restoreReason = "OAuth 不可用保护"
			break
		}
		remaining := deadline.Sub(workflow.Now(ctx))
		if remaining > 5*time.Second {
			remaining = 5 * time.Second
		}
		timer := workflow.NewTimer(ctx, remaining)
		selector := workflow.NewSelector(ctx)
		selector.AddReceive(signalChannel, func(channel workflow.ReceiveChannel, more bool) {
			channel.Receive(ctx, &signalPayload)
			restoreNow = true
		})
		selector.AddFuture(timer, func(workflow.Future) {})
		selector.Select(ctx)
	}
	if restoreNow {
		restoreReason = "立即恢复"
	}

	accountIDs, _ := disableResult["accountIds"].([]any)
	restoreCommand := map[string]any{
		"kind":            "upstream.apikey.cutoff",
		"phase":           "restore",
		"operationId":     cutoffOperationID,
		"durationSeconds": durationSeconds,
		"accountIds":      accountIDs,
		"trigger":         command["trigger"],
		"restoreReason":   restoreReason,
	}
	restoreRequest := OperationRequest{OperationID: input.Operation.OperationID + ":restore", Command: restoreCommand}
	var restoreResult map[string]any
	if err := workflow.ExecuteActivity(ctx, "executeOperation", restoreRequest).Get(ctx, &restoreResult); err != nil {
		return nil, err
	}

	result := map[string]any{
		"ok":            true,
		"disable":       disableResult,
		"guard":         guardResult,
		"restore":       restoreResult,
		"restoreReason": restoreReason,
	}
	for key, value := range restoreResult {
		result[key] = value
	}
	for key, value := range disableResult {
		if _, exists := result[key]; !exists {
			result[key] = value
		}
	}
	return result, nil
}

func ScoreRefreshScheduleWorkflow(ctx workflow.Context, input ScheduleInput) error {
	ctx = workflow.WithActivityOptions(ctx, scheduledActivityOptions(input.ActivityStartToCloseTimeout, 1))
	for iteration := 0; iteration < 50; iteration++ {
		request := OperationRequest{OperationID: fmt.Sprintf("%s:%d", workflow.GetInfo(ctx).WorkflowExecution.RunID, iteration), Command: map[string]any{"kind": "scores.refresh"}}
		_ = workflow.ExecuteActivity(ctx, "executeOperation", request).Get(ctx, nil)
		if err := workflow.Sleep(ctx, time.Duration(input.IntervalMS)*time.Millisecond); err != nil {
			return err
		}
	}
	return workflow.NewContinueAsNewError(ctx, ScoreRefreshScheduleWorkflow, input)
}

func UpstreamQuotaScheduleWorkflow(ctx workflow.Context, input ScheduleInput) error {
	timeout := input.RoundTimeoutMS
	if timeout < 1000 {
		timeout = input.IntervalMS - 1000
	}
	if timeout < 1000 {
		timeout = 1000
	}
	ctx = workflow.WithActivityOptions(ctx, scheduledActivityOptions((time.Duration(timeout)*time.Millisecond).String(), 1))
	for iteration := 0; iteration < 500; iteration++ {
		futures := make([]workflow.Future, 0, 3)
		for _, kind := range []string{"oauth.runtime.sample", "upstream.usage.sample", "pool.quality.sample"} {
			request := OperationRequest{OperationID: fmt.Sprintf("%s:upstream-quota:%d:%s", workflow.GetInfo(ctx).WorkflowExecution.RunID, iteration, kind), Command: map[string]any{"kind": kind}}
			futures = append(futures, workflow.ExecuteActivity(ctx, "executeOperation", request))
		}
		for _, future := range futures {
			_ = future.Get(ctx, nil)
		}
		if err := workflow.Sleep(ctx, time.Duration(input.IntervalMS)*time.Millisecond); err != nil {
			return err
		}
	}
	return workflow.NewContinueAsNewError(ctx, UpstreamQuotaScheduleWorkflow, input)
}

func IdleAccountProbeScheduleWorkflow(ctx workflow.Context, input ScheduleInput) error {
	ctx = workflow.WithActivityOptions(ctx, scheduledActivityOptions((time.Duration(input.RoundTimeoutMS)*time.Millisecond).String(), 1))
	for iteration := 0; iteration < 500; iteration++ {
		request := OperationRequest{OperationID: fmt.Sprintf("%s:idle-probe:%d", workflow.GetInfo(ctx).WorkflowExecution.RunID, iteration), Command: map[string]any{"kind": "account.idle-probe.run", "accountIds": []int{}, "rounds": 1}}
		_ = workflow.ExecuteActivity(ctx, "executeOperation", request).Get(ctx, nil)
		if err := workflow.Sleep(ctx, time.Duration(input.IntervalMS)*time.Millisecond); err != nil {
			return err
		}
	}
	return workflow.NewContinueAsNewError(ctx, IdleAccountProbeScheduleWorkflow, input)
}

func BugTeamCostScheduleWorkflow(ctx workflow.Context, input ScheduleInput) error {
	ctx = workflow.WithActivityOptions(ctx, scheduledActivityOptions(input.ActivityStartToCloseTimeout, 1))
	for iteration := 0; iteration < 500; iteration++ {
		request := OperationRequest{OperationID: fmt.Sprintf("%s:bugteam-cost:%d", workflow.GetInfo(ctx).WorkflowExecution.RunID, iteration), Command: map[string]any{"kind": "bugteam.cost.sample"}}
		_ = workflow.ExecuteActivity(ctx, "executeOperation", request).Get(ctx, nil)
		if err := workflow.Sleep(ctx, time.Duration(input.IntervalMS)*time.Millisecond); err != nil {
			return err
		}
	}
	return workflow.NewContinueAsNewError(ctx, BugTeamCostScheduleWorkflow, input)
}

func PriorityAutomationScheduleWorkflow(ctx workflow.Context, input ScheduleInput) error {
	ctx = workflow.WithActivityOptions(ctx, scheduledActivityOptions(input.ActivityStartToCloseTimeout, 1))
	intervalMS := input.IntervalMS
	if intervalMS < minimumPriorityAutomationPollMilliseconds {
		intervalMS = minimumPriorityAutomationPollMilliseconds
	}
	for iteration := 0; iteration < 5000; iteration++ {
		request := OperationRequest{
			OperationID: fmt.Sprintf("%s:priority-automation:%d", workflow.GetInfo(ctx).WorkflowExecution.RunID, iteration),
			Command:     map[string]any{"kind": "priority.automation.run"},
		}
		var result PriorityAutomationRunResult
		_ = workflow.ExecuteActivity(ctx, "executeOperation", request).Get(ctx, &result)
		delayMS := priorityAutomationDelayMilliseconds(result, intervalMS)
		if err := workflow.Sleep(ctx, time.Duration(delayMS)*time.Millisecond); err != nil {
			return err
		}
	}
	return workflow.NewContinueAsNewError(ctx, PriorityAutomationScheduleWorkflow, input)
}
