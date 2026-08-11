FROM golang:1.23-bookworm AS temporal-worker-builder

WORKDIR /src/go-worker
COPY go-worker/go.mod go-worker/go.sum ./
RUN go mod download
COPY go-worker/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/api2business-temporal-worker ./cmd/api2business-temporal-worker

FROM oven/bun:1.3.13-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /root/.bun/bin \
  && ln -s /usr/local/bin/bun /root/.bun/bin/bun

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY config ./config
COPY scripts ./scripts
COPY skills ./skills
COPY src ./src
COPY static ./static
COPY vite.config.ts ./vite.config.ts
COPY --from=temporal-worker-builder /out/api2business-temporal-worker /usr/local/bin/api2business-temporal-worker

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/api.ts", "--config", "config/api2business.example.yaml", "--runtime", "k8s"]
