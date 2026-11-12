package temporalworker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	sdkactivity "go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func TestLoadConfigReadsOwningYAML(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api2business.yaml")
	data := `
monitor:
  refreshIntervalMinutes: 5
  automaticRefresh: { enabled: true }
sub2api:
  idleProbe: { intervalSeconds: 60, roundTimeoutSeconds: 50 }
operations:
  upstreamSchedulingV2:
    enabled: true
    automation: { intervalSeconds: 120, recentCallLimit: 1000 }
    modelSyncPolicy:
      automaticDisabledPlatforms: [ deepseek, opencode_go, command_code ]
    scopes:
      codex: { enabled: true, platform: openai, features: { priorityAutomation: true, idleProbe: true } }
      claude: { enabled: true, platform: anthropic, idleProbeIntervalSeconds: 300, features: { priorityAutomation: true, idleProbe: true } }
      grok: { enabled: true, platform: grok, features: { priorityAutomation: true, idleProbe: true } }
      deepseek: { enabled: true, platform: deepseek, features: { priorityAutomation: true, idleProbe: true, modelSyncAutomation: true } }
      opencode: { enabled: true, platform: opencode_go, features: { priorityAutomation: true, idleProbe: true, modelSyncAutomation: true } }
  upstreamManagement: { quotaSampleIntervalSeconds: 300, quotaSampleTimeoutSeconds: 240 }
temporal:
  addressEnv: TEMPORAL_ADDRESS
  namespace: unidesk
  submissionTimeoutMs: 10000
  workflowExecutionTimeout: 12m
  activityStartToCloseTimeout: 10m
  retry: { maximumAttempts: 2 }
runtime:
  serverTargets:
    native:
      listenHost: 0.0.0.0
      listenPort: 8080
      workerHealthHost: 127.0.0.1
      workerHealthPort: 8081
      temporalTaskQueue: api2business-native
      scoreScheduleWorkflowId: api2business-native-score-refresh-schedule
      adminTokenEnv: API_TOKEN
`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig([]string{"--config", path, "--runtime", "native"}, func(key string) string {
		return map[string]string{"TEMPORAL_ADDRESS": "127.0.0.1:7233", "API_TOKEN": "test-token"}[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.APIBaseURL != "http://127.0.0.1:8080" || cfg.TaskQueue != "api2business-native" {
		t.Fatalf("unexpected runtime config: %#v", cfg)
	}
	if !cfg.AutomaticRefreshEnabled || cfg.V2AutomationIntervalSeconds != 120 || cfg.V2AutomationRecentCallLimit != 1000 {
		t.Fatalf("missing periodic worker config: %#v", cfg)
	}
	if strings.Join(cfg.V2IdleProbeScopes, ",") != "claude,codex,deepseek,grok" {
		t.Fatalf("expected Claude, Codex, DeepSeek and Grok idle probe scopes, got %#v", cfg.V2IdleProbeScopes)
	}
	if cfg.V2IdleProbeIntervals["codex"] != 60 || cfg.V2IdleProbeIntervals["claude"] != 300 || cfg.V2IdleProbeIntervals["grok"] != 60 {
		t.Fatalf("unexpected scoped idle probe intervals: %#v", cfg.V2IdleProbeIntervals)
	}
	if len(cfg.V2ModelSyncScopes) != 0 {
		t.Fatalf("expected disabled platforms to produce no automatic model sync scopes, got %#v", cfg.V2ModelSyncScopes)
	}
	if strings.Join(cfg.V2AutomaticDisabledPlatforms, ",") != "command_code,deepseek,opencode_go" {
		t.Fatalf("expected YAML-owned disabled platforms, got %#v", cfg.V2AutomaticDisabledPlatforms)
	}
}

func TestModelSyncAutomationAllowedOnlyForUnlistedPlatforms(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api2business.yaml")
	data := `
monitor: { refreshIntervalMinutes: 5, automaticRefresh: { enabled: false } }
sub2api: { idleProbe: { intervalSeconds: 60, roundTimeoutSeconds: 50 } }
operations:
  upstreamSchedulingV2:
    enabled: true
    automation: { intervalSeconds: 120, recentCallLimit: 1000 }
    modelSync: { batchSize: 10, intervalSeconds: 600 }
    modelSyncPolicy: { automaticDisabledPlatforms: [ deepseek, opencode_go, command_code ] }
    scopes:
      codex: { enabled: true, platform: openai, features: { modelSyncAutomation: true } }
      deepseek: { enabled: true, platform: deepseek, features: { modelSyncAutomation: true } }
  upstreamManagement: { quotaSampleIntervalSeconds: 300, quotaSampleTimeoutSeconds: 240 }
temporal: { addressEnv: TEMPORAL_ADDRESS, namespace: unidesk, submissionTimeoutMs: 10000, workflowExecutionTimeout: 12m, activityStartToCloseTimeout: 10m, retry: { maximumAttempts: 2 } }
runtime: { serverTargets: { native: { listenHost: 127.0.0.1, listenPort: 8080, workerHealthHost: 127.0.0.1, workerHealthPort: 8081, temporalTaskQueue: api2business-native, scoreScheduleWorkflowId: score, adminTokenEnv: API_TOKEN } } }
`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig([]string{"--config", path, "--runtime", "native"}, func(key string) string {
		return map[string]string{"TEMPORAL_ADDRESS": "127.0.0.1:7233", "API_TOKEN": "test-token"}[key]
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(cfg.V2ModelSyncScopes, ",") != "codex" {
		t.Fatalf("expected only Codex model sync, got %#v", cfg.V2ModelSyncScopes)
	}
	if scope := prohibitedModelSyncScope(OperationRequest{Command: map[string]any{
		"kind": "upstream.model-sync.v2.run", "scope": "deepseek", "platform": "deepseek",
	}}, cfg); scope != "deepseek" {
		t.Fatalf("expected deepseek model sync to be prohibited, got %q", scope)
	}
	if scope := prohibitedModelSyncScope(OperationRequest{Command: map[string]any{
		"kind": "upstream.model-sync.v2.run", "scope": "codex", "platform": "openai",
	}}, cfg); scope != "" {
		t.Fatalf("expected OpenAI model sync to remain allowed, got %q", scope)
	}
}

func TestLoadConfigRejectsRetiredGlobalSchedulingKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api2business.yaml")
	data := `
monitor: { refreshIntervalMinutes: 5, automaticRefresh: { enabled: false } }
operations: { legacyScheduling: { enabled: true } }
temporal: { addressEnv: TEMPORAL_ADDRESS, namespace: unidesk, submissionTimeoutMs: 1000, workflowExecutionTimeout: 1m, activityStartToCloseTimeout: 1m, retry: { maximumAttempts: 1 } }
runtime: { serverTargets: { native: { listenHost: 127.0.0.1, listenPort: 8080, workerHealthPort: 8081, temporalTaskQueue: queue, scoreScheduleWorkflowId: score, adminTokenEnv: API_TOKEN } } }
`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := LoadConfig([]string{"--config", path, "--runtime", "native"}, func(key string) string {
		return map[string]string{"TEMPORAL_ADDRESS": "127.0.0.1:7233", "API_TOKEN": "test-token"}[key]
	})
	if err == nil || !strings.Contains(err.Error(), "operations.legacyScheduling was retired") {
		t.Fatalf("expected retired scheduling rejection, got %v", err)
	}
}

func TestActivityOptionsPreserveTimeoutRetryAndCancellation(t *testing.T) {
	options := activityOptions("125ms", 3)
	if options.StartToCloseTimeout != 125*time.Millisecond || options.ScheduleToCloseTimeout != 0 {
		t.Fatalf("unexpected timeout options: %#v", options)
	}
	if !options.WaitForCancellation || options.RetryPolicy == nil || options.RetryPolicy.MaximumAttempts != 3 {
		t.Fatalf("unexpected cancellation/retry options: %#v", options)
	}
	scheduled := scheduledActivityOptions("125ms", 3)
	if scheduled.ScheduleToCloseTimeout != 125*time.Millisecond {
		t.Fatalf("unexpected schedule timeout options: %#v", scheduled)
	}
}

func TestConfiguredScheduleIdentitiesRemainStable(t *testing.T) {
	identities := configuredScheduleIdentities(Config{
		ScoreScheduleWorkflowID: "api2business-native-score-refresh-schedule",
		RefreshIntervalMinutes:  5,
	})
	expected := scheduleIdentities{
		Score:       "api2business-native-score-refresh-schedule-snapshot-5m-v3",
		Quota:       "api2business-native-score-refresh-schedule-upstream-quota-v4",
		BugTeamCost: "api2business-native-score-refresh-schedule-bugteam-cost-v1",
	}
	if identities != expected {
		t.Fatalf("schedule identities changed: %#v", identities)
	}
}

func TestReplacingScheduleOptionsTerminatesStaleCadence(t *testing.T) {
	options := replacingScheduleOptions("quota", "queue")
	if options.WorkflowIDConflictPolicy != enumspb.WORKFLOW_ID_CONFLICT_POLICY_TERMINATE_EXISTING {
		t.Fatalf("quota schedule must replace a stale running execution: %#v", options)
	}
	if options.WorkflowIDReusePolicy != enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE {
		t.Fatalf("quota schedule must allow reuse after replacement: %#v", options)
	}
}

func TestScopedAutomationIntervalHasSafeMinimum(t *testing.T) {
	if got := scopedAutomationIntervalMilliseconds(1000); got != minimumScopedAutomationIntervalMilliseconds {
		t.Fatalf("poll interval was not clamped: %d", got)
	}
	if got := scopedAutomationIntervalMilliseconds(120000); got != 120000 {
		t.Fatalf("valid poll interval was changed: %d", got)
	}
}

func TestExecuteOperationUsesAuthAndChecksIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "Bearer test-token" {
			t.Fatalf("authorization=%q", request.Header.Get("authorization"))
		}
		var operation OperationRequest
		if err := json.NewDecoder(request.Body).Decode(&operation); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(response).Encode(map[string]any{
			"ok": true, "operationId": operation.OperationID, "result": map[string]any{"done": true},
		})
	}))
	defer server.Close()

	activity := Activities{cfg: Config{APIBaseURL: server.URL, AdminToken: "test-token"}, http: server.Client()}
	result, err := activity.executeOperationHTTP(context.Background(), OperationRequest{OperationID: "op-1", Command: map[string]any{"kind": "scores.refresh"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["done"] != true {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestExecuteOperationRejectsIdentityMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{"ok": true, "operationId": "other", "result": nil})
	}))
	defer server.Close()
	activity := Activities{cfg: Config{APIBaseURL: server.URL}, http: server.Client()}
	_, err := activity.executeOperationHTTP(context.Background(), OperationRequest{OperationID: "expected"})
	if err == nil || !strings.Contains(err.Error(), "identity mismatch") {
		t.Fatalf("expected identity mismatch, got %v", err)
	}
}

func TestExecuteOperationRejectsOpenCodeIdleProbe(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		called = true
		_ = json.NewEncoder(response).Encode(map[string]any{"ok": true, "operationId": "blocked", "result": nil})
	}))
	defer server.Close()
	activity := Activities{cfg: Config{APIBaseURL: server.URL}, http: server.Client()}
	_, err := activity.executeOperationHTTP(context.Background(), OperationRequest{
		OperationID: "blocked",
		Command:     map[string]any{"kind": "account.idle-probe.run", "scope": "opencode"},
	})
	if err == nil || !strings.Contains(err.Error(), "prohibited") {
		t.Fatalf("expected opencode idle probe prohibition, got %v", err)
	}
	if called {
		t.Fatal("opencode idle probe must not reach the API")
	}
}

func TestExecuteOperationHonorsCancellation(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		select {
		case <-request.Context().Done():
		case <-release:
		}
	}))
	activity := Activities{cfg: Config{APIBaseURL: server.URL}, http: server.Client()}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(25*time.Millisecond, cancel)
	started := time.Now()
	_, err := activity.executeOperationHTTP(ctx, OperationRequest{OperationID: "cancel-me"})
	close(release)
	server.Close()
	if err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatalf("cancellation propagation took too long: %s", time.Since(started))
	}
}

func TestOperationWorkflowPropagatesCancellation(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.SetTestTimeout(2 * time.Second)
	environment.RegisterActivityWithOptions(func(ctx context.Context, _ OperationRequest) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}, sdkactivity.RegisterOptions{Name: "executeOperation"})
	environment.RegisterDelayedCallback(environment.CancelWorkflow, 100*time.Millisecond)
	environment.ExecuteWorkflow(OperationWorkflow, OperationWorkflowInput{
		Operation:                   OperationRequest{OperationID: "cancel-workflow", Command: map[string]any{"kind": "scores.refresh"}},
		ActivityStartToCloseTimeout: "1s", MaximumAttempts: 1,
	})
	if environment.GetWorkflowError() == nil {
		t.Fatal("expected workflow cancellation")
	}
}

func TestOperationWorkflowEnforcesActivityTimeout(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.SetTestTimeout(2 * time.Second)
	environment.RegisterActivityWithOptions(func(ctx context.Context, _ OperationRequest) (any, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}, sdkactivity.RegisterOptions{Name: "executeOperation"})
	environment.ExecuteWorkflow(OperationWorkflow, OperationWorkflowInput{
		Operation:                   OperationRequest{OperationID: "timeout-workflow", Command: map[string]any{"kind": "scores.refresh"}},
		ActivityStartToCloseTimeout: "25ms", MaximumAttempts: 1,
	})
	err := environment.GetWorkflowError()
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "timeout") {
		t.Fatalf("expected activity timeout, got %v", err)
	}
}
