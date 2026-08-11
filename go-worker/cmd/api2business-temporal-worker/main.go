package main

import (
	"context"
	"fmt"
	"os"

	"github.com/api2business/api2business/go-worker/internal/temporalworker"
)

func main() {
	cfg, err := temporalworker.LoadConfig(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "api2business-temporal-worker: %v\n", err)
		os.Exit(1)
	}
	if err := temporalworker.Run(context.Background(), cfg); err != nil {
		fmt.Fprintf(os.Stderr, "api2business-temporal-worker: %v\n", err)
		os.Exit(1)
	}
}
