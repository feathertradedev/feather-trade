import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createServer } from "node:http";
import test from "node:test";

import {
  AnalyticsInfrastructureState,
  assertAnalyticsBlockSource,
  assertPositionSnapshotProvider,
  assertProductionPriceVerifier,
  assertVerifiedPostgresTls,
  closeServerWithin,
  createCoalescedStoreHealthProbe,
  createAnalyticsShutdown,
  parseAnalyticsRuntimeConfig,
  strictBooleanFromEnv,
  superviseAnalyticsFatalFailure,
  waitForSustainedDatabaseHealthFailure,
  type AnalyticsStateStore
} from "../src/index.js";

test("runtime configuration fails closed outside explicit localnet", () => {
  assert.throws(() => parseAnalyticsRuntimeConfig({}), /ANALYTICS_ENVIRONMENT/);
  assert.throws(
    () => parseAnalyticsRuntimeConfig({ ANALYTICS_ENVIRONMENT: "testnet" }),
    /ANALYTICS_DATABASE_URL is required/
  );
  assert.throws(
    () => parseAnalyticsRuntimeConfig({
      ANALYTICS_ENVIRONMENT: "mainnet",
      ANALYTICS_DATABASE_URL: "postgres://analytics.example/feather?sslmode=verify-full",
      ANALYTICS_STATE_PATH: "checkpoint.json"
    }),
    /ANALYTICS_STATE_PATH is localnet-only/
  );
  assert.throws(
    () => parseAnalyticsRuntimeConfig({
      ANALYTICS_ENVIRONMENT: "testnet",
      ANALYTICS_DATABASE_URL: "postgres://analytics.example/feather?sslmode=verify-full",
      ANALYTICS_ALLOW_FIXED_TEST_PRICES: "1"
    }),
    /requires ANALYTICS_ENVIRONMENT=localnet/
  );
  assert.throws(
    () => parseAnalyticsRuntimeConfig({
      ANALYTICS_ENVIRONMENT: "mainnet",
      ANALYTICS_DATABASE_URL: "postgres://analytics.example/feather?sslmode=verify-full"
    }),
    /ANALYTICS_PRICE_VERIFIER_MODULE is required/
  );
  assert.throws(
    () => parseAnalyticsRuntimeConfig({
      ANALYTICS_ENVIRONMENT: "mainnet",
      ANALYTICS_DATABASE_URL: "postgres://analytics.example/feather?sslmode=verify-full",
      ANALYTICS_PRICE_VERIFIER_MODULE: "/run/feather/adapters/verifier.mjs"
    }),
    /ANALYTICS_DEPLOYMENT_IDENTITY is required/
  );

  assert.deepEqual(
    parseAnalyticsRuntimeConfig({
      ANALYTICS_ENVIRONMENT: "localnet",
      ANALYTICS_ALLOW_FIXED_TEST_PRICES: "1",
      ANALYTICS_SHUTDOWN_TIMEOUT_MS: "2500"
    }),
    {
      environment: "localnet",
      localnet: true,
      databaseUrl: null,
      databaseSchema: "feather_analytics",
      deploymentIdentity: null,
      runtimeCustodyPath: null,
      runtimeCustodySha256: null,
      allowFixedTestPrices: true,
      databaseHealthIntervalMs: 5_000,
      databaseFailureGraceMs: 120_000,
      readinessTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_500
    }
  );
});

test("production database configuration requires unambiguous verified TLS", () => {
  assert.doesNotThrow(() => assertVerifiedPostgresTls(
    "postgresql://feather:secret@db.example/feather?sslmode=verify-full"
  ));
  for (const unsafe of [
    "postgresql://db.example/feather",
    "postgresql://db.example/feather?sslmode=require",
    "postgresql://db.example/feather?sslmode=no-verify",
    "postgresql://db.example/feather?sslmode=verify-full&sslmode=no-verify",
    "https://db.example/feather?sslmode=verify-full"
  ]) {
    assert.throws(() => assertVerifiedPostgresTls(unsafe));
  }

  const configured = parseAnalyticsRuntimeConfig({
    ANALYTICS_ENVIRONMENT: "mainnet",
    ANALYTICS_DATABASE_URL: "postgresql://db.example/feather?sslmode=verify-full",
    ANALYTICS_PRICE_VERIFIER_MODULE: "/run/feather/adapters/price-verifier.mjs",
    ANALYTICS_DEPLOYMENT_IDENTITY: "mainnet:0123456789abcdef",
    ANALYTICS_RUNTIME_CUSTODY: "/run/feather/config/runtime-custody.json",
    ANALYTICS_RUNTIME_CUSTODY_SHA256: "a".repeat(64)
  });
  assert.equal(configured.deploymentIdentity, "mainnet:0123456789abcdef");
  assert.equal(configured.runtimeCustodySha256, "a".repeat(64));
  assert.throws(() => parseAnalyticsRuntimeConfig({
    ANALYTICS_ENVIRONMENT: "localnet",
    ANALYTICS_DATABASE_HEALTH_INTERVAL_MS: "5000",
    ANALYTICS_DATABASE_FAILURE_GRACE_MS: "30000"
  }), /at least 120000/);
  assert.throws(() => parseAnalyticsRuntimeConfig({
    ANALYTICS_ENVIRONMENT: "localnet",
    ANALYTICS_DATABASE_FAILURE_GRACE_MS: "300001"
  }), /at most 300000/);
  assert.throws(() => parseAnalyticsRuntimeConfig({
    ANALYTICS_ENVIRONMENT: "localnet",
    ANALYTICS_READINESS_TIMEOUT_MS: "30001"
  }), /at most 30000/);
});

test("trusted proxy configuration accepts only exact explicit booleans", () => {
  assert.equal(strictBooleanFromEnv({}, "ANALYTICS_TRUST_PROXY", false), false);
  assert.equal(strictBooleanFromEnv({ ANALYTICS_TRUST_PROXY: "true" }, "ANALYTICS_TRUST_PROXY", false), true);
  assert.equal(strictBooleanFromEnv({ ANALYTICS_TRUST_PROXY: "1" }, "ANALYTICS_TRUST_PROXY", false), true);
  assert.equal(strictBooleanFromEnv({ ANALYTICS_TRUST_PROXY: "false" }, "ANALYTICS_TRUST_PROXY", true), false);
  for (const unsafe of ["TRUE", "yes", " true", "2", ""]) {
    assert.throws(
      () => strictBooleanFromEnv({ ANALYTICS_TRUST_PROXY: unsafe }, "ANALYTICS_TRUST_PROXY", false),
      /must be exactly/
    );
  }
});

test("production block sources must provide supervised live following", () => {
  const backfillOnly = {
    async fetchPage() {
      return { blocks: [], nextCursor: null, done: true };
    }
  };
  assert.doesNotThrow(() => assertAnalyticsBlockSource(backfillOnly, { requiresLiveSource: false }));
  assert.throws(
    () => assertAnalyticsBlockSource(backfillOnly, { requiresLiveSource: true }),
    /must provide followLive/
  );
  assert.doesNotThrow(() => assertAnalyticsBlockSource({
    ...backfillOnly,
    async followLive() {}
  }, { requiresLiveSource: true }));
});

test("production rejects a missing price verifier before ingesting any block", () => {
  assert.doesNotThrow(() => assertProductionPriceVerifier(null, { localnet: true }));
  assert.throws(
    () => assertProductionPriceVerifier(null, { localnet: false }),
    /Production ANALYTICS_PRICE_VERIFIER_MODULE must provide a price verifier/
  );
  assert.throws(
    () => assertProductionPriceVerifier({}, { localnet: true }),
    /must return a verifier with verify/
  );
  assert.throws(
    () => assertProductionPriceVerifier(undefined, { localnet: true, configured: true }),
    /must return a verifier with verify/
  );
  assert.throws(
    () => assertPositionSnapshotProvider(undefined),
    /must return a provider with load/
  );
});

test("readiness tracks infrastructure without conflating business analytics health", async () => {
  let leaseHeld = false;
  let databaseHealthy = true;
  const store = stateStore({
    hasWriterLease: () => leaseHeld,
    healthcheck: async () => {
      if (!databaseHealthy) throw new Error("database unavailable");
    }
  });
  const state = new AnalyticsInfrastructureState({
    store,
    requiresWriterLease: true,
    requiresLiveSource: true
  });

  assert.equal(state.livenessProbe(), true);
  assert.equal(await state.readinessProbe(), false);
  state.markReconciled();
  state.markLiveSourceRunning();
  assert.equal(await state.readinessProbe(), false, "the writer lease gates readiness");
  leaseHeld = true;
  assert.equal(await state.readinessProbe(), true);
  databaseHealthy = false;
  assert.equal(await state.readinessProbe(), false, "database loss removes readiness");
  databaseHealthy = true;
  assert.equal(await state.readinessProbe(), true, "a transient database failure may recover");
  state.markLiveSourceStopped();
  assert.equal(await state.readinessProbe(), false, "a stopped live source removes readiness");
  state.markLiveSourceRunning();
  assert.equal(await state.readinessProbe(), true);
  state.beginShutdown();
  assert.equal(await state.readinessProbe(), false, "draining starts before connections close");
  assert.equal(state.livenessProbe(), true, "a draining process remains live");

  const failed = new AnalyticsInfrastructureState({
    store,
    requiresWriterLease: false,
    requiresLiveSource: false
  });
  failed.markFailed();
  assert.equal(failed.livenessProbe(), false);
  assert.equal(await failed.readinessProbe(), false);
});

test("bounded shutdown is idempotent and propagates a failing store close", async () => {
  const closeFailure = new Error("database close failed");
  let beginCount = 0;
  let closeCount = 0;
  const abortController = new AbortController();
  let server: Server | null = null;
  let store: AnalyticsStateStore | null = null;
  const shutdown = createAnalyticsShutdown({
    server: () => server,
    store: () => store,
    liveSourceSettled: async () => {},
    timeoutMs: 1_000,
    beginShutdown: () => {
      beginCount += 1;
      abortController.abort();
    }
  });

  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  store = stateStore({
    close: async () => {
      closeCount += 1;
      throw closeFailure;
    }
  });

  const first = shutdown("SIGTERM");
  const second = shutdown("SIGINT");
  assert.strictEqual(second, first);
  assert.equal(abortController.signal.aborted, true, "shutdown aborts adapter work before draining");
  await assert.rejects(first, closeFailure);
  assert.equal(beginCount, 1);
  assert.equal(closeCount, 1);
  assert.equal(server.listening, false);
});

test("readiness deadlines share one stalled healthcheck instead of queueing probes", async () => {
  let healthchecks = 0;
  const state = new AnalyticsInfrastructureState({
    store: stateStore({
      healthcheck: () => {
        healthchecks += 1;
        return new Promise<void>(() => {});
      }
    }),
    requiresWriterLease: false,
    requiresLiveSource: false,
    readinessTimeoutMs: 10
  });
  state.markReconciled();

  assert.deepEqual(await Promise.all([state.readinessProbe(), state.readinessProbe()]), [false, false]);
  assert.equal(await state.readinessProbe(), false);
  assert.equal(healthchecks, 1);
});

test("server shutdown forcibly closes connections at its configured bound", async () => {
  let forced = 0;
  const server = {
    close() {
      return this;
    },
    closeAllConnections() {
      forced += 1;
    }
  } as unknown as Server;

  assert.equal(await closeServerWithin(server, 10), false);
  assert.equal(forced, 1);
});

test("fatal infrastructure supervision fails liveness, drains once, and requests process termination", async () => {
  let resolveFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => { resolveFailure = resolve; });
  const events: string[] = [];
  const supervision = superviseAnalyticsFatalFailure({
    failure,
    isStopping: () => false,
    markFailed: () => events.push("failed"),
    shutdown: async (reason) => { events.push(`shutdown:${reason}`); },
    report: (message) => events.push(`report:${message}`),
    setExitCode: (code) => events.push(`exitCode:${code}`),
    terminate: (code) => events.push(`terminate:${code}`),
    reason: "writer-lease-failed",
    label: "writer lease failed"
  });
  resolveFailure(new Error("backend ended"));
  await supervision;
  assert.deepEqual(events, [
    "failed",
    "exitCode:1",
    "report:writer lease failed: backend ended",
    "shutdown:writer-lease-failed",
    "terminate:1"
  ]);
});

test("a non-settling database healthcheck is bounded and remains one coalesced probe", async () => {
  let calls = 0;
  const probe = createCoalescedStoreHealthProbe(() => {
    calls += 1;
    return new Promise<void>(() => {});
  });
  assert.deepEqual(await Promise.all([probe(10), probe(10)]), [false, false]);
  assert.equal(await probe(10), false);
  assert.equal(calls, 1, "timed-out polls do not queue more work behind a blackholed connection");
});

test("database health supervision requires a sustained failure and resets after recovery", async () => {
  let now = 0;
  let sustainedCalls = 0;
  const sustained = await waitForSustainedDatabaseHealthFailure({
    probe: async () => { sustainedCalls += 1; return false; },
    signal: new AbortController().signal,
    intervalMs: 10,
    failureGraceMs: 20,
    now: () => now,
    wait: async (delay) => { now += delay; }
  });
  assert.match(sustained?.message ?? "", /continuously for at least 20ms/);
  assert.equal(sustainedCalls, 3);

  now = 0;
  const observations = [false, false, true, false, false, false];
  const recovered = await waitForSustainedDatabaseHealthFailure({
    probe: async () => observations.shift() ?? false,
    signal: new AbortController().signal,
    intervalMs: 10,
    failureGraceMs: 20,
    now: () => now,
    wait: async (delay) => { now += delay; }
  });
  assert.match(recovered?.message ?? "", /continuously for at least 20ms/);
  assert.equal(observations.length, 0, "recovery resets the first failure window before a later sustained outage");
});

test("a legitimate queued write may cross the old grace while a nonsettling session still trips the latch", async () => {
  let now = 0;
  let observations = 0;
  const controller = new AbortController();
  const recovered = await waitForSustainedDatabaseHealthFailure({
    probe: async () => {
      observations += 1;
      return observations === 6;
    },
    signal: controller.signal,
    intervalMs: 10_000,
    failureGraceMs: 120_000,
    now: () => now,
    wait: async (delay) => {
      now += delay;
      if (observations === 6) controller.abort();
    }
  });
  assert.equal(recovered, null);
  assert.equal(observations, 6);
  assert.equal(now, 60_000, "the queued operation remained tolerated after crossing the old 30s grace");

  let healthcheckCalls = 0;
  let stuckNow = 0;
  const stuckProbe = createCoalescedStoreHealthProbe(() => {
    healthcheckCalls += 1;
    return new Promise<void>(() => {});
  });
  const stuck = await waitForSustainedDatabaseHealthFailure({
    probe: () => stuckProbe(5),
    signal: new AbortController().signal,
    intervalMs: 10,
    failureGraceMs: 20,
    now: () => stuckNow,
    wait: async (delay) => { stuckNow += delay; }
  });
  assert.match(stuck?.message ?? "", /continuously for at least 20ms/);
  assert.equal(healthcheckCalls, 1, "a stuck session is polled without queuing additional health queries");
});

function stateStore(overrides: Partial<AnalyticsStateStore> = {}): AnalyticsStateStore {
  return {
    async load() {
      return null;
    },
    async save() {},
    ...overrides
  };
}
