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

func PriorityAutomationScheduleWorkflow(ctx workflow.Context, input ScheduleInput) error {
	ctx = workflow.WithActivityOptions(ctx, scheduledActivityOptions(input.ActivityStartToCloseTimeout, 1))
	for iteration := 0; iteration < 5000; iteration++ {
		request := OperationRequest{
			OperationID: fmt.Sprintf("%s:priority-automation:%d", workflow.GetInfo(ctx).WorkflowExecution.RunID, iteration),
			Command:     map[string]any{"kind": "priority.automation.run"},
		}
		_ = workflow.ExecuteActivity(ctx, "executeOperation", request).Get(ctx, nil)
		if err := workflow.Sleep(ctx, time.Duration(input.IntervalMS)*time.Millisecond); err != nil {
			return err
		}
	}
	return workflow.NewContinueAsNewError(ctx, PriorityAutomationScheduleWorkflow, input)
}
