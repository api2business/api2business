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

ENV NODE_ENV=production
EXPOSE 8080

CMD ["bun", "src/api.ts", "--config", "config/api2business.example.yaml", "--runtime", "k8s"]
