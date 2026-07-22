import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AnalyticsEngine } from "./engine.js";
import {
  verifiedModuleDataUrl,
  verifyAnalyticsRuntimeCustody,
  type VerifiedAnalyticsRuntimeFile
} from "./custody.js";
import { DexScreenerMarketMetadataProvider } from "./discovery-metadata.js";
import { PostgresAnalyticsStore } from "./postgres-store.js";
import {
  AnalyticsInfrastructureState,
  assertAnalyticsBlockSource,
  assertPositionSnapshotProvider,
  assertProductionPriceVerifier,
  createCoalescedStoreHealthProbe,
  createAnalyticsShutdown,
  numberFromEnv,
  parseAnalyticsRuntimeConfig,
  strictBooleanFromEnv,
  superviseAnalyticsFatalFailure,
  waitForSustainedDatabaseHealthFailure
} from "./runtime.js";
import {
  AnalyticsApiService,
  AnalyticsCheckpointStore,
  startAnalyticsHttpServer,
  type AnalyticsStateStore,
  type AnalyticsBlockSource,
  type PositionSnapshotProvider,
  type PriceSampleVerifier
} from "./service.js";
import type { PricePolicy } from "./types.js";

export interface AnalyticsRuntimeHandle {
  server: Server;
  signal: AbortSignal;
  shutdown(reason?: string): Promise<void>;
}

export async function startAnalyticsRuntime(
  env: NodeJS.ProcessEnv = process.env
): Promise<AnalyticsRuntimeHandle> {
  const config = parseAnalyticsRuntimeConfig(env);
  const abortController = new AbortController();
  let store: AnalyticsStateStore | null = null;
  let server: Server | null = null;
  let infrastructure: AnalyticsInfrastructureState | null = null;
  let liveSourceSettled: Promise<void> = Promise.resolve();
  const shutdown = createAnalyticsShutdown({
    server: () => server,
    store: () => store,
    liveSourceSettled: () => liveSourceSettled,
    timeoutMs: config.shutdownTimeoutMs,
    beginShutdown: (reason) => {
      infrastructure?.beginShutdown();
      abortController.abort(new Error(`Analytics runtime ${reason}`));
    }
  });
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  };
  const shutdownAndRemoveHandlers = (reason = "shutdown") => {
    const pending = shutdown(reason);
    void pending.then(removeSignalHandlers, removeSignalHandlers);
    return pending;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      void shutdownAndRemoveHandlers(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          process.stderr.write(`Analytics shutdown failed: ${errorMessage(error)}\n`);
          process.exit(1);
        }
      );
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const policyPath = env.ANALYTICS_PRICE_POLICIES;
    if (!policyPath) throw new Error("ANALYTICS_PRICE_POLICIES must point to a JSON PricePolicy array");
    const priceVerifierModule = env.ANALYTICS_PRICE_VERIFIER_MODULE?.trim() || null;
    const blockSourceModule = requiredModulePath(env, "ANALYTICS_BLOCK_SOURCE_MODULE");
    const positionSnapshotModule = requiredModulePath(env, "ANALYTICS_POSITION_SNAPSHOT_MODULE");
    const custody = config.localnet
      ? null
      : await verifyAnalyticsRuntimeCustody({
          inventoryPath: config.runtimeCustodyPath!,
          inventorySha256: config.runtimeCustodySha256!,
          deploymentIdentity: config.deploymentIdentity!,
          environment: config.environment === "testnet" ? "testnet" : "mainnet",
          expectedPaths: {
            pricePolicies: policyPath,
            priceVerifierModule: priceVerifierModule!,
            blockSourceModule,
            positionSnapshotModule
          }
        });
    const policiesSource = custody === null
      ? await readFile(policyPath, "utf8")
      : custody.files.pricePolicies.contents.toString("utf8");
    const policies = JSON.parse(policiesSource) as PricePolicy[];
    const engine = new AnalyticsEngine(policies, {
      maxHeadLagSeconds: numberFromEnv(env, "ANALYTICS_MAX_HEAD_LAG_SECONDS", 120),
      maxPositionSnapshotAgeSeconds: numberFromEnv(env, "ANALYTICS_MAX_POSITION_SNAPSHOT_AGE_SECONDS", 300)
    });
    store = config.databaseUrl === null
      ? new AnalyticsCheckpointStore(env.ANALYTICS_STATE_PATH ?? ".local/analytics/checkpoint.json")
      : new PostgresAnalyticsStore({
          connectionString: config.databaseUrl,
          schema: config.databaseSchema,
          connectionTimeoutMs: config.readinessTimeoutMs,
          healthcheckTimeoutMs: config.readinessTimeoutMs,
          keepAliveInitialDelayMs: numberFromEnv(
            env,
            "ANALYTICS_DATABASE_KEEPALIVE_INITIAL_DELAY_MS",
            10_000
          )
        });

    if (store.acquireWriterLease !== undefined) await store.acquireWriterLease();
    if (!config.localnet && (store.healthcheck === undefined || store.hasWriterLease?.() !== true)) {
      throw new Error("Production analytics requires a healthy PostgreSQL writer lease");
    }
    await store.healthcheck?.();
    if (store instanceof PostgresAnalyticsStore) {
      const probe = createCoalescedStoreHealthProbe(() => store!.healthcheck!());
      const sustainedHealthFailure = waitForSustainedDatabaseHealthFailure({
        probe: () => probe(config.readinessTimeoutMs),
        signal: abortController.signal,
        intervalMs: config.databaseHealthIntervalMs,
        failureGraceMs: config.databaseFailureGraceMs
      }).then(
        (error) => error ?? new Promise<Error>(() => {}),
        (error: unknown) => error instanceof Error ? error : new Error(String(error))
      );
      void superviseAnalyticsFatalFailure({
        failure: Promise.race([store.writerLeaseFailure(), sustainedHealthFailure]),
        isStopping: () => abortController.signal.aborted,
        markFailed: () => infrastructure?.markFailed(),
        shutdown: shutdownAndRemoveHandlers,
        report: (message) => process.stderr.write(`${message}\n`),
        setExitCode: (code) => { process.exitCode = code; },
        terminate: isDirectExecution() ? (code) => process.exit(code) : undefined,
        reason: "database-health-failed",
        label: "Analytics PostgreSQL infrastructure failed permanently"
      });
    }

    const priceVerifier = await loadPriceVerifier(
      priceVerifierModule,
      custody?.files.priceVerifierModule ?? null
    );
    assertProductionPriceVerifier(priceVerifier, {
      localnet: config.localnet,
      configured: priceVerifierModule !== null
    });
    const positionSnapshotProvider = await loadPositionSnapshotProvider(
      positionSnapshotModule,
      custody?.files.positionSnapshotModule ?? null
    );
    assertPositionSnapshotProvider(positionSnapshotProvider);
    const blockSource = await loadBlockSource(
      blockSourceModule,
      custody?.files.blockSourceModule ?? null,
      abortController.signal,
      !config.localnet
    );
    if (blockSource === null) {
      throw new Error("ANALYTICS_BLOCK_SOURCE_MODULE is required for canonical startup attestation and live ingestion");
    }

    const service = await AnalyticsApiService.create({
      engine,
      store,
      allowFixedTestPrices: config.allowFixedTestPrices,
      priceVerifier,
      positionSnapshotProvider,
      positionSnapshotTimeoutMs: numberFromEnv(env, "ANALYTICS_POSITION_SNAPSHOT_TIMEOUT_MS", 5_000),
      marketMetadataProvider: new DexScreenerMarketMetadataProvider()
    });
    const initialHealth = service.getHealth();
    const retainedHead = initialHealth.headBlock === null
      ? null
      : {
          number: initialHealth.headBlock,
          hash: initialHealth.headHash!,
          timestamp: initialHealth.headTimestamp!
        };
    abortController.signal.throwIfAborted();
    const startCursor = blockSource.startupCursor === undefined
      ? null
      : await blockSource.startupCursor({
          persistedCursor: initialHealth.backfillCursor,
          retainedHead
        }, abortController.signal);
    if (startCursor !== null && typeof startCursor !== "string") {
      throw new Error("Analytics block source startupCursor() must return a string or null");
    }
    const result = await service.backfill(
      (cursor) => {
        abortController.signal.throwIfAborted();
        return blockSource.fetchPage(cursor, abortController.signal);
      },
      {
        startCursor,
        maxPages: numberFromEnv(env, "ANALYTICS_BACKFILL_MAX_PAGES", 10_000)
      }
    );
    if (result.status !== "complete") {
      throw new Error(
        `Analytics backfill stopped ${result.status} at ${result.cursor ?? "start"}: ${result.error ?? "page cap"}`
      );
    }

    const runtimeInfrastructure = new AnalyticsInfrastructureState({
      store,
      requiresWriterLease: !config.localnet,
      requiresLiveSource: !config.localnet,
      readinessTimeoutMs: config.readinessTimeoutMs
    });
    infrastructure = runtimeInfrastructure;
    runtimeInfrastructure.markReconciled();
    const host = env.ANALYTICS_HOST ?? "127.0.0.1";
    const port = numberFromEnv(env, "ANALYTICS_PORT", 8787);
    server = await startAnalyticsHttpServer({
      service,
      host,
      port,
      ingestToken: env.ANALYTICS_INGEST_TOKEN ?? null,
      corsOrigins: commaSeparatedEnv(env, "ANALYTICS_CORS_ORIGINS"),
      trustProxy: strictBooleanFromEnv(env, "ANALYTICS_TRUST_PROXY", false),
      maxStreamsPerIp: numberFromEnv(env, "ANALYTICS_MAX_STREAMS_PER_IP", 20),
      graphqlRequestsPerMinute: numberFromEnv(env, "ANALYTICS_GRAPHQL_REQUESTS_PER_MINUTE", 120),
      graphqlRateLimitClients: numberFromEnv(env, "ANALYTICS_GRAPHQL_RATE_LIMIT_CLIENTS", 4_096),
      livenessProbe: runtimeInfrastructure.livenessProbe,
      readinessProbe: runtimeInfrastructure.readinessProbe
    });

    if (blockSource.followLive !== undefined) {
      runtimeInfrastructure.markLiveSourceRunning();
      const rawLiveSource = Promise.resolve().then(() => blockSource.followLive!(
        (block) => service.ingestBlock(block),
        (head) => service.reconcileCanonicalHead(head),
        abortController.signal
      ));
      liveSourceSettled = rawLiveSource.then(() => undefined, () => undefined);
      void rawLiveSource.then(
        () => {
          runtimeInfrastructure.markLiveSourceStopped();
          if (!abortController.signal.aborted) {
            runtimeInfrastructure.markFailed();
            process.stderr.write("Analytics live source stopped unexpectedly\n");
            process.exitCode = 1;
            void shutdownAndRemoveHandlers("live-source-stopped").catch((error: unknown) => {
              process.stderr.write(`Analytics shutdown failed: ${errorMessage(error)}\n`);
            });
          }
        },
        (error: unknown) => {
          runtimeInfrastructure.markLiveSourceStopped();
          if (!abortController.signal.aborted) {
            runtimeInfrastructure.markFailed();
            process.stderr.write(`Analytics live source failed: ${errorMessage(error)}\n`);
            process.exitCode = 1;
            void shutdownAndRemoveHandlers("live-source-failed").catch((shutdownError: unknown) => {
              process.stderr.write(`Analytics shutdown failed: ${errorMessage(shutdownError)}\n`);
            });
          }
        }
      );
    }

    process.stdout.write(`Feather analytics listening on http://${host}:${port}\n`);
    return {
      server,
      signal: abortController.signal,
      shutdown: shutdownAndRemoveHandlers
    };
  } catch (error) {
    try {
      await shutdownAndRemoveHandlers("startup-failed");
    } catch {
      // Preserve the startup error that made the runtime fail closed.
    }
    throw error;
  }
}

function commaSeparatedEnv(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

async function loadPriceVerifier(
  modulePath: string | null,
  verifiedFile: VerifiedAnalyticsRuntimeFile | null
): Promise<PriceSampleVerifier | null> {
  if (modulePath === null) return null;
  const loaded = (await import(moduleSpecifier(modulePath, verifiedFile))) as {
    createPriceVerifier?: () => PriceSampleVerifier | Promise<PriceSampleVerifier>;
  };
  if (typeof loaded.createPriceVerifier !== "function") {
    throw new Error("ANALYTICS_PRICE_VERIFIER_MODULE must export createPriceVerifier()");
  }
  return loaded.createPriceVerifier();
}

async function loadBlockSource(
  modulePath: string | null,
  verifiedFile: VerifiedAnalyticsRuntimeFile | null,
  signal: AbortSignal,
  requiresLiveSource: boolean
): Promise<AnalyticsBlockSource | null> {
  if (modulePath === null) return null;
  const loaded = (await import(moduleSpecifier(modulePath, verifiedFile))) as {
    createBlockSource?: (options?: { signal?: AbortSignal }) => AnalyticsBlockSource | Promise<AnalyticsBlockSource>;
  };
  if (typeof loaded.createBlockSource !== "function") {
    throw new Error("ANALYTICS_BLOCK_SOURCE_MODULE must export createBlockSource()");
  }
  const source = await loaded.createBlockSource({ signal });
  assertAnalyticsBlockSource(source, { requiresLiveSource });
  return source;
}

async function loadPositionSnapshotProvider(
  modulePath: string | null,
  verifiedFile: VerifiedAnalyticsRuntimeFile | null
): Promise<PositionSnapshotProvider | null> {
  if (modulePath === null) return null;
  const loaded = (await import(moduleSpecifier(modulePath, verifiedFile))) as {
    createPositionSnapshotProvider?: () => PositionSnapshotProvider | Promise<PositionSnapshotProvider>;
  };
  if (typeof loaded.createPositionSnapshotProvider !== "function") {
    throw new Error("ANALYTICS_POSITION_SNAPSHOT_MODULE must export createPositionSnapshotProvider()");
  }
  return loaded.createPositionSnapshotProvider();
}

function moduleSpecifier(modulePath: string, verifiedFile: VerifiedAnalyticsRuntimeFile | null): string {
  return verifiedFile === null
    ? pathToFileURL(resolve(modulePath)).href
    : verifiedModuleDataUrl(verifiedFile);
}

function requiredModulePath(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    await startAnalyticsRuntime();
  } catch (error) {
    process.stderr.write(`Analytics startup failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
