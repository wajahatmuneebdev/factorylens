FROM node:24.11.0-bookworm-slim@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152 AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/tsconfig.json packages/contracts/
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/contracts/src packages/contracts/src
COPY apps/api/src apps/api/src
COPY apps/web/index.html apps/web/vite.config.ts apps/web/
COPY apps/web/src apps/web/src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24.11.0-bookworm-slim@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152

ARG IMAGE_VERSION
ARG SOURCE_REVISION
RUN test -n "$IMAGE_VERSION" && test -n "$SOURCE_REVISION"

LABEL org.opencontainers.image.title="factorylens-web" \
      org.opencontainers.image.description="FactoryLens combined web and API service" \
      org.opencontainers.image.source="https://github.com/wajahatmuneebdev/factorylens" \
      org.opencontainers.image.version="$IMAGE_VERSION" \
      org.opencontainers.image.revision="$SOURCE_REVISION"

ENV API_HOST=0.0.0.0 \
    API_PORT=8080 \
    NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/package.json package.json
COPY --from=build --chown=node:node /app/apps/api/package.json apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist packages/contracts/dist

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
