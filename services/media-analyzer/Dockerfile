FROM node:24.20.0-alpine AS builder
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts/enforce-pnpm.mjs ./scripts/enforce-pnpm.mjs
RUN pnpm install --frozen-lockfile
COPY services/media-analyzer services/media-analyzer
RUN pnpm analyzer:build

FROM node:24.20.0-alpine
RUN apk add --no-cache ca-certificates ffmpeg font-noto-cjk poppler-utils tesseract-ocr tesseract-ocr-data-eng tesseract-ocr-data-chi_sim
RUN addgroup -S analyzer
RUN adduser -S -G analyzer -u 10002 analyzer
WORKDIR /app
COPY --from=builder --chown=analyzer:analyzer /workspace/services/media-analyzer/dist/server.mjs /app/server.mjs
ENV NODE_ENV=production
ENV ANALYZER_HOST=0.0.0.0
ENV ANALYZER_PORT=8090
ENV ANALYZER_FFMPEG_COMMAND=ffmpeg
ENV ANALYZER_FFPROBE_COMMAND=ffprobe
ENV ANALYZER_PDFTOPPM_COMMAND=pdftoppm
ENV ANALYZER_TESSERACT_COMMAND=tesseract
USER analyzer
EXPOSE 8090
STOPSIGNAL SIGTERM
CMD ["node", "/app/server.mjs"]
