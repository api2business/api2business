package temporalworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

type Activities struct {
	cfg  Config
	http *http.Client
}

func (a Activities) ExecuteOperation(ctx context.Context, operation OperationRequest) (any, error) {
	activity.RecordHeartbeat(ctx, map[string]any{"operationId": operation.OperationID})
	return a.executeOperationHTTP(ctx, operation)
}

func (a Activities) executeOperationHTTP(ctx context.Context, operation OperationRequest) (any, error) {
	payload, err := json.Marshal(operation)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.cfg.APIBaseURL+"/api/internal/execute-worker-operation", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Bearer "+a.cfg.AdminToken)
	req.Header.Set("content-type", "application/json")
	res, err := a.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var envelope struct {
		OK          bool   `json:"ok"`
		OperationID string `json:"operationId"`
		Result      any    `json:"result"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 || !envelope.OK {
		return nil, fmt.Errorf("worker operation HTTP %d: %s", res.StatusCode, envelope.Error)
	}
	if envelope.OperationID != operation.OperationID {
		return nil, errors.New("worker operation identity mismatch")
	}
	return envelope.Result, nil
}

func startWorkflow(c client.Client, options client.StartWorkflowOptions, workflowName string, input ScheduleInput) error {
	_, err := c.ExecuteWorkflow(context.Background(), options, workflowName, input)
	var already *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &already) {
		return nil
	}
	return err
}

func terminateIfRunning(c client.Client, namespace, workflowID, reason string) error {
	description, err := c.DescribeWorkflowExecution(context.Background(), workflowID, "")
	if err != nil {
		var notFound *serviceerror.NotFound
		if errors.As(err, &notFound) {
			return nil
		}
		return err
	}
	if description.WorkflowExecutionInfo.GetStatus() == enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING {
		return c.TerminateWorkflow(context.Background(), workflowID, description.WorkflowExecutionInfo.GetExecution().GetRunId(), reason)
	}
	_ = namespace
	return nil
}

func scheduleOptions(id, taskQueue string) client.StartWorkflowOptions {
	return client.StartWorkflowOptions{
		ID: id, TaskQueue: taskQueue,
		WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
	}
}

type scheduleIdentities struct {
	Score, Quota, IdleProbe, IdleProvision, PriorityAutomation string
}

func configuredScheduleIdentities(cfg Config) scheduleIdentities {
	base := cfg.ScoreScheduleWorkflowID
	return scheduleIdentities{
		Score:              fmt.Sprintf("%s-snapshot-%dm-v3", base, cfg.RefreshIntervalMinutes),
		Quota:              base + "-upstream-quota-v4",
		IdleProbe:          base + "-idle-account-probe-v5",
		IdleProvision:      base + "-idle-account-provision-v1",
		PriorityAutomation: base + "-priority-automation-v1",
	}
}

func ensureSchedules(c client.Client, cfg Config) error {
	base := cfg.ScoreScheduleWorkflowID
	identities := configuredScheduleIdentities(cfg)
	if cfg.AutomaticRefreshEnabled && cfg.RefreshIntervalMinutes > 0 {
		for _, legacy := range []string{base, fmt.Sprintf("%s-snapshot-%dm-v1", base, cfg.RefreshIntervalMinutes), fmt.Sprintf("%s-snapshot-%dm-v2", base, cfg.RefreshIntervalMinutes)} {
			if err := terminateIfRunning(c, cfg.Namespace, legacy, "migrated to Go score snapshot schedule v3"); err != nil {
				return err
			}
		}
		if err := startWorkflow(c, scheduleOptions(identities.Score, cfg.TaskQueue), "scoreRefreshScheduleWorkflow", ScheduleInput{IntervalMS: cfg.RefreshIntervalMinutes * 60000, ActivityStartToCloseTimeout: cfg.ActivityTimeout, MaximumAttempts: 1}); err != nil {
			return err
		}
	}
	if cfg.QuotaIntervalSeconds > 0 {
		for _, legacy := range []string{base + "-upstream-quota", base + "-upstream-quota-v2", base + "-upstream-quota-v3"} {
			if err := terminateIfRunning(c, cfg.Namespace, legacy, "migrated to Go upstream sampling schedule v4"); err != nil {
				return err
			}
		}
		if err := startWorkflow(c, scheduleOptions(identities.Quota, cfg.TaskQueue), "upstreamQuotaScheduleWorkflow", ScheduleInput{IntervalMS: cfg.QuotaIntervalSeconds * 1000, RoundTimeoutMS: cfg.QuotaTimeoutSeconds * 1000, ActivityStartToCloseTimeout: cfg.ActivityTimeout, MaximumAttempts: int32(cfg.MaximumAttempts)}); err != nil {
			return err
		}
	}
	if cfg.IdleProbeEnabled {
		for _, legacy := range []string{base + "-idle-account-probe-v2", base + "-idle-account-probe-v3", base + "-idle-account-probe-v4"} {
			if err := terminateIfRunning(c, cfg.Namespace, legacy, "migrated to Go idle probe schedule v5"); err != nil {
				return err
			}
		}
		if err := terminateIfRunning(c, cfg.Namespace, identities.IdleProvision, "probe isolation provisioning is manual-only"); err != nil {
			return err
		}
		if err := startWorkflow(c, scheduleOptions(identities.IdleProbe, cfg.TaskQueue), "idleAccountProbeScheduleWorkflow", ScheduleInput{IntervalMS: cfg.IdleProbeIntervalSeconds * 1000, RoundTimeoutMS: cfg.IdleProbeTimeoutSeconds * 1000, ActivityStartToCloseTimeout: cfg.ActivityTimeout, MaximumAttempts: 1}); err != nil {
			return err
		}
	} else {
		for _, id := range []string{identities.IdleProbe, identities.IdleProvision} {
			if err := terminateIfRunning(c, cfg.Namespace, id, "idle probe disabled by configuration"); err != nil {
				return err
			}
		}
	}
	if cfg.AutomationPollMilliseconds > 0 {
		if err := startWorkflow(c, scheduleOptions(identities.PriorityAutomation, cfg.TaskQueue), "priorityAutomationScheduleWorkflow", ScheduleInput{IntervalMS: cfg.AutomationPollMilliseconds, ActivityStartToCloseTimeout: cfg.ActivityTimeout, MaximumAttempts: 1}); err != nil {
			return err
		}
	}
	return nil
}

func waitForAPI(ctx context.Context, cfg Config) error {
	httpClient := &http.Client{Timeout: 2 * time.Second}
	var lastError error
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.APIBaseURL+"/health", nil)
		if err != nil {
			return err
		}
		response, err := httpClient.Do(request)
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
			err = fmt.Errorf("API readiness returned HTTP %d", response.StatusCode)
		}
		lastError = err
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %v", ctx.Err(), lastError)
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func watchSchedules(ctx context.Context, c client.Client, cfg Config) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := ensureSchedules(c, cfg); err != nil {
				fmt.Fprintf(os.Stderr, "{\"ok\":false,\"component\":\"schedule-watchdog\",\"error\":%q,\"valuesPrinted\":false}\n", err.Error())
			}
		}
	}
}

func Run(ctx context.Context, cfg Config) error {
	c, err := client.Dial(client.Options{HostPort: cfg.Address, Namespace: cfg.Namespace})
	if err != nil {
		return err
	}
	defer c.Close()
	w := worker.New(c, cfg.TaskQueue, worker.Options{})
	w.RegisterWorkflowWithOptions(OperationWorkflow, workflow.RegisterOptions{Name: "operationWorkflow"})
	w.RegisterWorkflowWithOptions(ScoreRefreshScheduleWorkflow, workflow.RegisterOptions{Name: "scoreRefreshScheduleWorkflow"})
	w.RegisterWorkflowWithOptions(UpstreamQuotaScheduleWorkflow, workflow.RegisterOptions{Name: "upstreamQuotaScheduleWorkflow"})
	w.RegisterWorkflowWithOptions(IdleAccountProbeScheduleWorkflow, workflow.RegisterOptions{Name: "idleAccountProbeScheduleWorkflow"})
	w.RegisterWorkflowWithOptions(PriorityAutomationScheduleWorkflow, workflow.RegisterOptions{Name: "priorityAutomationScheduleWorkflow"})
	activityTimeout, parseErr := time.ParseDuration(cfg.ActivityTimeout)
	if parseErr != nil || activityTimeout <= 0 {
		activityTimeout = 15 * time.Minute
	}
	w.RegisterActivityWithOptions(Activities{cfg: cfg, http: &http.Client{Timeout: activityTimeout}}.ExecuteOperation, activity.RegisterOptions{Name: "executeOperation"})
	apiContext, cancelAPI := context.WithTimeout(ctx, 30*time.Second)
	if err := waitForAPI(apiContext, cfg); err != nil {
		cancelAPI()
		return fmt.Errorf("API dependency readiness: %w", err)
	}
	cancelAPI()
	if err := w.Start(); err != nil {
		return err
	}
	defer w.Stop()
	if err := ensureSchedules(c, cfg); err != nil {
		return err
	}
	watchContext, stopWatch := context.WithCancel(ctx)
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		watchSchedules(watchContext, c, cfg)
	}()
	var ready atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(res http.ResponseWriter, _ *http.Request) {
		status := http.StatusOK
		if !ready.Load() {
			status = http.StatusServiceUnavailable
		}
		res.Header().Set("content-type", "application/json")
		res.WriteHeader(status)
		_ = json.NewEncoder(res).Encode(map[string]any{"ok": ready.Load(), "component": "api2business-worker", "runtime": "go", "namespace": cfg.Namespace, "taskQueue": cfg.TaskQueue})
	})
	mux.HandleFunc("/metrics", func(res http.ResponseWriter, _ *http.Request) {
		res.Header().Set("content-type", "text/plain; version=0.0.4")
		fmt.Fprintf(res, "# TYPE api2business_worker_ready gauge\napi2business_worker_ready %d\n", map[bool]int{true: 1}[ready.Load()])
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	listener, err := net.Listen("tcp", net.JoinHostPort(cfg.HealthHost, strconv.Itoa(cfg.HealthPort)))
	if err != nil {
		return fmt.Errorf("worker health listener: %w", err)
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	ready.Store(true)
	fmt.Printf("{\"ok\":true,\"component\":\"api2business-worker\",\"runtime\":\"go\",\"namespace\":%q,\"taskQueue\":%q,\"healthPort\":%d,\"valuesPrinted\":false}\n", cfg.Namespace, cfg.TaskQueue, cfg.HealthPort)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	select {
	case <-ctx.Done():
	case <-signals:
	case err := <-serveErr:
		ready.Store(false)
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("worker health server: %w", err)
		}
	}
	ready.Store(false)
	stopWatch()
	<-watchDone
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdown)
}
