FROM node:24.20.0-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

FROM builder AS worker

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

USER node
STOPSIGNAL SIGTERM
CMD ["pnpm", "evaluation:worker"]

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
CMD ["node", "server.js"]
