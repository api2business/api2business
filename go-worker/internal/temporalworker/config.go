package temporalworker

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Address, Namespace, TaskQueue, ScoreScheduleWorkflowID     string
	APIBaseURL, AdminToken, HealthHost                         string
	HealthPort, RefreshIntervalMinutes                         int
	ActivityTimeout, WorkflowExecutionTimeout                  string
	SubmissionTimeout                                          time.Duration
	MaximumAttempts, QuotaIntervalSeconds, QuotaTimeoutSeconds int
	AutomationPollMilliseconds                                 int
	AutomaticRefreshEnabled                                    bool
	IdleProbeEnabled                                           bool
	IdleProbeIntervalSeconds, IdleProbeTimeoutSeconds          int
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
			Enabled             bool `yaml:"enabled"`
			IntervalSeconds     int  `yaml:"intervalSeconds"`
			RoundTimeoutSeconds int  `yaml:"roundTimeoutSeconds"`
		} `yaml:"idleProbe"`
	} `yaml:"sub2api"`
	Operations struct {
		AutomationPollMilliseconds int `yaml:"automationPollMs"`
		UpstreamManagement         struct {
			QuotaSampleIntervalSeconds int `yaml:"quotaSampleIntervalSeconds"`
			QuotaSampleTimeoutSeconds  int `yaml:"quotaSampleTimeoutSeconds"`
		} `yaml:"upstreamManagement"`
	} `yaml:"operations"`
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
	return Config{
		Address: address, Namespace: raw.Temporal.Namespace, TaskQueue: target.TemporalTaskQueue,
		ScoreScheduleWorkflowID: target.ScoreScheduleWorkflowID,
		APIBaseURL:              "http://" + net.JoinHostPort(host, strconv.Itoa(target.ListenPort)), AdminToken: token,
		HealthHost: target.WorkerHealthHost, HealthPort: target.WorkerHealthPort,
		RefreshIntervalMinutes: raw.Monitor.RefreshIntervalMinutes, AutomaticRefreshEnabled: raw.Monitor.AutomaticRefresh.Enabled,
		ActivityTimeout: raw.Temporal.ActivityTimeout, WorkflowExecutionTimeout: raw.Temporal.WorkflowExecutionTimeout,
		SubmissionTimeout:          time.Duration(raw.Temporal.SubmissionTimeoutMS) * time.Millisecond,
		MaximumAttempts:            raw.Temporal.Retry.MaximumAttempts,
		QuotaIntervalSeconds:       raw.Operations.UpstreamManagement.QuotaSampleIntervalSeconds,
		QuotaTimeoutSeconds:        raw.Operations.UpstreamManagement.QuotaSampleTimeoutSeconds,
		AutomationPollMilliseconds: raw.Operations.AutomationPollMilliseconds,
		IdleProbeEnabled:           raw.Sub2API.IdleProbe.Enabled, IdleProbeIntervalSeconds: raw.Sub2API.IdleProbe.IntervalSeconds,
		IdleProbeTimeoutSeconds: raw.Sub2API.IdleProbe.RoundTimeoutSeconds,
	}, nil
}
