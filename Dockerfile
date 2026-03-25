FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
  && mkdir -p /app/storage /app/keystore /app/backups

FROM gcr.io/distroless/nodejs22-debian13:nonroot AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV STREAMCHAIN_NODE_MODE=self-hosted
ENV STREAMCHAIN_STORAGE_DIR=/app/storage
ENV STREAMCHAIN_KEYSTORE_DIR=/app/keystore
ENV STREAMCHAIN_BACKUP_DIR=/app/backups
COPY --from=builder --chown=65532:65532 /app/.next/standalone ./
COPY --from=builder --chown=65532:65532 /app/.next/static ./.next/static
COPY --from=builder --chown=65532:65532 /app/data ./data
COPY --from=builder --chown=65532:65532 /app/storage ./storage
COPY --from=builder --chown=65532:65532 /app/keystore ./keystore
COPY --from=builder --chown=65532:65532 /app/backups ./backups
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["/app/server.js"]
