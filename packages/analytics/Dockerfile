FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS toolchain

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /workspace

RUN corepack enable \
  && corepack prepare pnpm@11.7.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/analytics/package.json packages/analytics/package.json

FROM toolchain AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --filter @robinhood-lb/analytics...

FROM toolchain AS build
RUN pnpm install --frozen-lockfile --filter @robinhood-lb/analytics...
COPY packages/analytics/tsconfig.json packages/analytics/tsconfig.json
COPY packages/analytics/schema.graphql packages/analytics/schema.graphql
COPY packages/analytics/src packages/analytics/src
RUN pnpm --filter @robinhood-lb/analytics build

FROM node:24.12.0-bookworm-slim@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99 AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /workspace/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /workspace/packages/analytics/node_modules ./packages/analytics/node_modules
COPY --chown=node:node packages/analytics/package.json packages/analytics/package.json
COPY --chown=node:node packages/analytics/schema.graphql packages/analytics/schema.graphql
COPY --from=build --chown=node:node /workspace/packages/analytics/dist ./packages/analytics/dist

USER node
EXPOSE 8787

# This image is production-only. Refuse the checkpoint-file fallback and refuse
# to start without each externally reviewed production data adapter.
CMD ["/bin/sh", "-ec", ": \"${ANALYTICS_DATABASE_URL:?ANALYTICS_DATABASE_URL is required}\"; : \"${ANALYTICS_PRICE_POLICIES:?ANALYTICS_PRICE_POLICIES is required}\"; : \"${ANALYTICS_PRICE_VERIFIER_MODULE:?ANALYTICS_PRICE_VERIFIER_MODULE is required}\"; : \"${ANALYTICS_BLOCK_SOURCE_MODULE:?ANALYTICS_BLOCK_SOURCE_MODULE is required}\"; : \"${ANALYTICS_POSITION_SNAPSHOT_MODULE:?ANALYTICS_POSITION_SNAPSHOT_MODULE is required}\"; : \"${ANALYTICS_DEPLOYMENT_IDENTITY:?ANALYTICS_DEPLOYMENT_IDENTITY is required}\"; : \"${ANALYTICS_RUNTIME_CUSTODY:?ANALYTICS_RUNTIME_CUSTODY is required}\"; : \"${ANALYTICS_RUNTIME_CUSTODY_SHA256:?ANALYTICS_RUNTIME_CUSTODY_SHA256 is required}\"; exec node packages/analytics/dist/src/server-cli.js"]
