# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS frontend-build
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=s/be1490eb-fe3f-4375-9927-54973fbfdd67-/root/.npm,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY . .
RUN --mount=type=cache,id=s/be1490eb-fe3f-4375-9927-54973fbfdd67-/workspace/.next/cache,target=/workspace/.next/cache \
    npm run build

FROM rust:1.98-bookworm AS backend-build
WORKDIR /workspace/backend
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/src ./src
RUN --mount=type=cache,id=s/be1490eb-fe3f-4375-9927-54973fbfdd67-/usr/local/cargo/registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=s/be1490eb-fe3f-4375-9927-54973fbfdd67-/workspace/backend/target,target=/workspace/backend/target \
    cargo build --release --locked && \
    cp target/release/aeralyth-api /tmp/aeralyth-api

FROM caddy:2.10.2-alpine AS caddy-binary

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    AERALYTH_API_HOST=127.0.0.1 \
    AERALYTH_API_PORT=8081 \
    AERALYTH_API_ORIGIN=http://127.0.0.1:8081 \
    AERALYTH_FRONTEND_PORT=3000 \
    HOSTNAME=127.0.0.1 \
    NEXT_TELEMETRY_DISABLED=1

RUN apt-get update && \
    apt-get install --yes --no-install-recommends ca-certificates postgresql-client && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 1001 aeralyth && \
    useradd --system --uid 1001 --gid aeralyth --create-home aeralyth

WORKDIR /app
COPY --from=caddy-binary /usr/bin/caddy /usr/bin/caddy
COPY --from=backend-build /tmp/aeralyth-api /app/bin/aeralyth-api
COPY --from=frontend-build --chown=aeralyth:aeralyth /workspace/.next/standalone /app/frontend
COPY --from=frontend-build --chown=aeralyth:aeralyth /workspace/.next/static /app/frontend/.next/static
COPY --from=frontend-build --chown=aeralyth:aeralyth /workspace/public /app/frontend/public
COPY --chown=aeralyth:aeralyth deployment/Caddyfile /etc/caddy/Caddyfile
COPY --chown=aeralyth:aeralyth database/init /app/database/init
COPY --chown=aeralyth:aeralyth database/production /app/database/production
COPY --chown=aeralyth:aeralyth scripts /app/scripts
RUN chmod 0755 /app/bin/aeralyth-api /app/scripts/*.sh

USER aeralyth
EXPOSE 8080
CMD ["/app/scripts/start-production.sh"]
