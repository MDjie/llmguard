FROM node:24.20.0-alpine AS dependencies

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts/enforce-pnpm.mjs ./scripts/enforce-pnpm.mjs
RUN pnpm install --frozen-lockfile

FROM dependencies AS builder

COPY . .
RUN pnpm run build

FROM node:24.20.0-alpine AS worker

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Workers execute TypeScript through Node's tsx loader. Keep their dependency
# tree, but do not inherit the builder filesystem: only the runtime source,
# generated contracts, and supported worker entrypoints belong in the image.
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node data/content-safety/lexicon/prompt-injection-bilingual.v1.json ./data/content-safety/lexicon/
COPY --chown=node:node data/content-safety/taxonomy/risk-registry.v1.json ./data/content-safety/taxonomy/
COPY --chown=node:node packages/contracts/generated ./packages/contracts/generated
COPY --chown=node:node packages/contracts-appliance/generated ./packages/contracts-appliance/generated
COPY --chown=node:node \
    scripts/archive-worker.ts \
    scripts/artifact-verifier-worker.ts \
    scripts/audio-video-worker.ts \
    scripts/audit-chain-worker.ts \
    scripts/audit-export-worker.ts \
    scripts/audit-timestamp-worker.ts \
    scripts/callback-dispatcher-worker.ts \
    scripts/content-marking-worker.ts \
    scripts/document-image-worker.ts \
    scripts/evaluation-worker.ts \
    scripts/gateway-request-worker.ts \
    scripts/gateway-shadow-worker.ts \
    scripts/native-multimodal-worker.ts \
    scripts/code-sentinel-worker.ts \
    scripts/rag-ingest-worker.ts \
    scripts/run-worker.mjs \
    scripts/security-scan-worker.ts \
    ./scripts/

COPY --chown=node:node scripts/release/gateway-v2-migrate.mjs scripts/release/gateway-v2-identity-preflight.mjs ./scripts/release/
COPY --chown=node:node drizzle ./drizzle

USER node
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "scripts/run-worker.mjs", "evaluation"]

FROM node:24.20.0-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=5000 \
    HOSTNAME=0.0.0.0

COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 5000
STOPSIGNAL SIGTERM
COPY --chown=node:node scripts/runtime-ingress.mjs scripts/gateway-v2-runtime-config.mjs scripts/gateway-v2-health.mjs ./scripts/
CMD ["node", "scripts/runtime-ingress.mjs", "server.js"]
