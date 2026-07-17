FROM oven/bun:1.3.13-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY config ./config
COPY src ./src
COPY static ./static

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/api.ts", "--config", "config/sub2rank.yaml", "--runtime", "k8s"]
