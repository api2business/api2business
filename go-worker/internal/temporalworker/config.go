package temporalworker

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Address, Namespace, TaskQueue, ScoreScheduleWorkflowID      string
	APIBaseURL, AdminToken, HealthHost                          string
	HealthPort, RefreshIntervalMinutes                          int
	ActivityTimeout, WorkflowExecutionTimeout                   string
	SubmissionTimeout                                           time.Duration
	MaximumAttempts, QuotaIntervalSeconds, QuotaTimeoutSeconds  int
	V2AutomationIntervalSeconds, V2AutomationRecentCallLimit    int
	V2ScopeNames, V2PriorityAutomationScopes, V2IdleProbeScopes []string
	AutomaticRefreshEnabled                                     bool
	IdleProbeIntervalSeconds, IdleProbeTimeoutSeconds           int
	BugTeamCostMonitorEnabled                                   bool
	BugTeamCostIntervalSeconds                                  int
}

type fileConfig struct {
	Monitor struct {
		RefreshIntervalMinutes int `yaml:"refreshIntervalMinutes"`
		AutomaticRefresh       struct {
			Enabled bool `yaml:"enabled"`
		} `yaml:"automaticRefresh"`
	} `yaml:"monitor"`
	Sub2API struct {
		IdleProbe struct {
			IntervalSeconds     int `yaml:"intervalSeconds"`
			RoundTimeoutSeconds int `yaml:"roundTimeoutSeconds"`
		} `yaml:"idleProbe"`
	} `yaml:"sub2api"`
	Operations struct {
		UpstreamSchedulingV2 struct {
			Enabled    bool `yaml:"enabled"`
			Automation struct {
				IntervalSeconds int `yaml:"intervalSeconds"`
				RecentCallLimit int `yaml:"recentCallLimit"`
			} `yaml:"automation"`
			Scopes map[string]struct {
				Enabled  bool   `yaml:"enabled"`
				Platform string `yaml:"platform"`
				Features struct {
					PriorityAutomation bool `yaml:"priorityAutomation"`
					IdleProbe          bool `yaml:"idleProbe"`
				} `yaml:"features"`
			} `yaml:"scopes"`
		} `yaml:"upstreamSchedulingV2"`
		UpstreamManagement struct {
			QuotaSampleIntervalSeconds int `yaml:"quotaSampleIntervalSeconds"`
			QuotaSampleTimeoutSeconds  int `yaml:"quotaSampleTimeoutSeconds"`
		} `yaml:"upstreamManagement"`
	} `yaml:"operations"`
	BugTeam struct {
		Monitor struct {
			Enabled               bool `yaml:"enabled"`
			SampleIntervalSeconds int  `yaml:"sampleIntervalSeconds"`
		} `yaml:"monitor"`
	} `yaml:"bugTeam"`
	Temporal struct {
		AddressEnv               string `yaml:"addressEnv"`
		Namespace                string `yaml:"namespace"`
		SubmissionTimeoutMS      int    `yaml:"submissionTimeoutMs"`
		WorkflowExecutionTimeout string `yaml:"workflowExecutionTimeout"`
		ActivityTimeout          string `yaml:"activityStartToCloseTimeout"`
		Retry                    struct {
			MaximumAttempts int `yaml:"maximumAttempts"`
		} `yaml:"retry"`
	} `yaml:"temporal"`
	Runtime struct {
		ServerTargets map[string]struct {
			ListenHost              string `yaml:"listenHost"`
			ListenPort              int    `yaml:"listenPort"`
			WorkerHealthPort        int    `yaml:"workerHealthPort"`
			WorkerHealthHost        string `yaml:"workerHealthHost"`
			TemporalTaskQueue       string `yaml:"temporalTaskQueue"`
			ScoreScheduleWorkflowID string `yaml:"scoreScheduleWorkflowId"`
			AdminTokenEnv           string `yaml:"adminTokenEnv"`
		} `yaml:"serverTargets"`
	} `yaml:"runtime"`
}

func LoadConfig(args []string, get func(string) string) (Config, error) {
	configPath, runtimeID := "", ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--config" && i+1 < len(args) {
			i++
			configPath = args[i]
		} else if args[i] == "--runtime" && i+1 < len(args) {
			i++
			runtimeID = args[i]
		}
	}
	if configPath == "" || runtimeID == "" {
		return Config{}, errors.New("--config and --runtime are required")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		return Config{}, err
	}
	var raw fileConfig
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return Config{}, err
	}
	var rawKeys map[string]any
	if err := yaml.Unmarshal(data, &rawKeys); err != nil {
		return Config{}, err
	}
	if operations, ok := rawKeys["operations"].(map[string]any); ok {
		for _, retired := range []string{"legacyScheduling", "automationPollMs", "automationRunTimeoutMs", "automationFailureBackoffMaxMs", "automationFailureRetryLimit", "automationFailureCooldownMs"} {
			if _, exists := operations[retired]; exists {
				return Config{}, fmt.Errorf("operations.%s was retired; configure operations.upstreamSchedulingV2 instead", retired)
			}
		}
	}
	target, ok := raw.Runtime.ServerTargets[runtimeID]
	if !ok {
		return Config{}, fmt.Errorf("runtime.serverTargets.%s does not exist", runtimeID)
	}
	address := strings.TrimSpace(get(raw.Temporal.AddressEnv))
	if address == "" {
		return Config{}, fmt.Errorf("%s is required", raw.Temporal.AddressEnv)
	}
	token := strings.TrimSpace(get(target.AdminTokenEnv))
	if token == "" {
		return Config{}, fmt.Errorf("%s is required", target.AdminTokenEnv)
	}
	if raw.Temporal.Namespace == "" || target.TemporalTaskQueue == "" || target.ScoreScheduleWorkflowID == "" {
		return Config{}, errors.New("temporal namespace, task queue, and score schedule workflow ID are required")
	}
	if target.ListenPort < 1 || target.WorkerHealthPort < 1 {
		return Config{}, errors.New("API and worker health ports must be positive")
	}
	if _, err := time.ParseDuration(raw.Temporal.ActivityTimeout); err != nil {
		return Config{}, fmt.Errorf("invalid temporal.activityStartToCloseTimeout: %w", err)
	}
	if _, err := time.ParseDuration(raw.Temporal.WorkflowExecutionTimeout); err != nil {
		return Config{}, fmt.Errorf("invalid temporal.workflowExecutionTimeout: %w", err)
	}
	if raw.Temporal.SubmissionTimeoutMS < 1 {
		return Config{}, errors.New("temporal.submissionTimeoutMs must be positive")
	}
	host := target.ListenHost
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	var v2ScopeNames, v2PriorityAutomationScopes, v2IdleProbeScopes []string
	for name, scope := range raw.Operations.UpstreamSchedulingV2.Scopes {
		v2ScopeNames = append(v2ScopeNames, name)
		if raw.Operations.UpstreamSchedulingV2.Enabled {
			if !scope.Enabled {
				continue
			}
			if scope.Features.PriorityAutomation {
				v2PriorityAutomationScopes = append(v2PriorityAutomationScopes, name)
			}
			if scope.Features.IdleProbe && (scope.Platform == "openai" || scope.Platform == "anthropic" || scope.Platform == "grok") {
				v2IdleProbeScopes = append(v2IdleProbeScopes, name)
			}
		}
	}
	sort.Strings(v2PriorityAutomationScopes)
	sort.Strings(v2IdleProbeScopes)
	sort.Strings(v2ScopeNames)
	return Config{
		Address: address, Namespace: raw.Temporal.Namespace, TaskQueue: target.TemporalTaskQueue,
		ScoreScheduleWorkflowID: target.ScoreScheduleWorkflowID,
		APIBaseURL:              "http://" + net.JoinHostPort(host, strconv.Itoa(target.ListenPort)), AdminToken: token,
		HealthHost: target.WorkerHealthHost, HealthPort: target.WorkerHealthPort,
		RefreshIntervalMinutes: raw.Monitor.RefreshIntervalMinutes, AutomaticRefreshEnabled: raw.Monitor.AutomaticRefresh.Enabled,
		ActivityTimeout: raw.Temporal.ActivityTimeout, WorkflowExecutionTimeout: raw.Temporal.WorkflowExecutionTimeout,
		SubmissionTimeout:           time.Duration(raw.Temporal.SubmissionTimeoutMS) * time.Millisecond,
		MaximumAttempts:             raw.Temporal.Retry.MaximumAttempts,
		QuotaIntervalSeconds:        raw.Operations.UpstreamManagement.QuotaSampleIntervalSeconds,
		QuotaTimeoutSeconds:         raw.Operations.UpstreamManagement.QuotaSampleTimeoutSeconds,
		V2AutomationIntervalSeconds: raw.Operations.UpstreamSchedulingV2.Automation.IntervalSeconds,
		V2AutomationRecentCallLimit: raw.Operations.UpstreamSchedulingV2.Automation.RecentCallLimit,
		V2PriorityAutomationScopes:  v2PriorityAutomationScopes,
		V2IdleProbeScopes:           v2IdleProbeScopes,
		V2ScopeNames:                v2ScopeNames,
		IdleProbeIntervalSeconds:    raw.Sub2API.IdleProbe.IntervalSeconds,
		IdleProbeTimeoutSeconds:     raw.Sub2API.IdleProbe.RoundTimeoutSeconds,
		BugTeamCostMonitorEnabled:   raw.BugTeam.Monitor.Enabled, BugTeamCostIntervalSeconds: raw.BugTeam.Monitor.SampleIntervalSeconds,
	}, nil
}
