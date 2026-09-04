FROM node:24.20.0-alpine AS builder
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY scripts/enforce-pnpm.mjs ./scripts/enforce-pnpm.mjs
RUN pnpm install --frozen-lockfile
COPY packages/contracts-appliance packages/contracts-appliance
COPY src/lib/appliance src/lib/appliance
COPY src/lib/policy-bundle/canonical.ts src/lib/policy-bundle/canonical.ts
COPY src/lib/artifacts src/lib/artifacts
COPY src/lib/guard-engine-v2 src/lib/guard-engine-v2
COPY services/appliance-agent services/appliance-agent
RUN pnpm appliance-agent:build

FROM node:24.20.0-alpine
RUN addgroup -S appliance && adduser -S -G appliance -u 10003 appliance
WORKDIR /app
COPY --from=builder --chown=appliance:appliance /workspace/services/appliance-agent/dist/server.mjs /app/server.mjs
ENV NODE_ENV=production
ENV APPLIANCE_AGENT_CONFIG=/etc/guardllm/appliance-agent.json
USER appliance
EXPOSE 8091
STOPSIGNAL SIGTERM
CMD ["node", "/app/server.mjs"]
