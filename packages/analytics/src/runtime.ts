import type { Server } from "node:http";

import type {
  AnalyticsBlockSource,
  AnalyticsStateStore,
  PositionSnapshotProvider,
  PriceSampleVerifier
} from "./service.js";

export type AnalyticsEnvironment = "localnet" | "testnet" | "mainnet";

const MINIMUM_DATABASE_FAILURE_GRACE_MS = 120_000;

export interface AnalyticsRuntimeConfig {
  environment: AnalyticsEnvironment;
  localnet: boolean;
  databaseUrl: string | null;
  databaseSchema: string;
  deploymentIdentity: string | null;
  runtimeCustodyPath: string | null;
  runtimeCustodySha256: string | null;
  allowFixedTestPrices: boolean;
  databaseHealthIntervalMs: number;
  databaseFailureGraceMs: number;
  readinessTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export function parseAnalyticsRuntimeConfig(env: NodeJS.ProcessEnv): AnalyticsRuntimeConfig {
  const environment = env.ANALYTICS_ENVIRONMENT;
  if (environment !== "localnet" && environment !== "testnet" && environment !== "mainnet") {
    throw new Error("ANALYTICS_ENVIRONMENT must be localnet, testnet, or mainnet");
  }
  const localnet = environment === "localnet";
  const databaseUrl = nonEmptyOptional(env.ANALYTICS_DATABASE_URL);
  if (!localnet && databaseUrl === null) {
    throw new Error("ANALYTICS_DATABASE_URL is required outside localnet");
  }
  if (!localnet) assertVerifiedPostgresTls(databaseUrl!);
  if (!localnet && nonEmptyOptional(env.ANALYTICS_STATE_PATH) !== null) {
    throw new Error("ANALYTICS_STATE_PATH is localnet-only");
  }
  const allowFixedTestPrices = booleanFromEnv(env, "ANALYTICS_ALLOW_FIXED_TEST_PRICES", false);
  if (allowFixedTestPrices && !localnet) {
    throw new Error("ANALYTICS_ALLOW_FIXED_TEST_PRICES requires ANALYTICS_ENVIRONMENT=localnet");
  }
  if (!localnet && nonEmptyOptional(env.ANALYTICS_PRICE_VERIFIER_MODULE) === null) {
    throw new Error("ANALYTICS_PRICE_VERIFIER_MODULE is required outside localnet");
  }
  const deploymentIdentity = nonEmptyOptional(env.ANALYTICS_DEPLOYMENT_IDENTITY);
  const runtimeCustodyPath = nonEmptyOptional(env.ANALYTICS_RUNTIME_CUSTODY);
  const runtimeCustodySha256 = nonEmptyOptional(env.ANALYTICS_RUNTIME_CUSTODY_SHA256);
  if (!localnet) {
    if (deploymentIdentity === null) {
      throw new Error("ANALYTICS_DEPLOYMENT_IDENTITY is required outside localnet");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(deploymentIdentity)) {
      throw new Error("ANALYTICS_DEPLOYMENT_IDENTITY is invalid");
    }
    if (runtimeCustodyPath === null) {
      throw new Error("ANALYTICS_RUNTIME_CUSTODY is required outside localnet");
    }
    if (runtimeCustodySha256 === null || !/^[0-9a-f]{64}$/.test(runtimeCustodySha256)) {
      throw new Error("ANALYTICS_RUNTIME_CUSTODY_SHA256 must be 64 lowercase hexadecimal characters outside localnet");
    }
  }
  const databaseHealthIntervalMs = numberFromEnv(
    env,
    "ANALYTICS_DATABASE_HEALTH_INTERVAL_MS",
    5_000
  );
  const databaseFailureGraceMs = numberFromEnv(
    env,
    "ANALYTICS_DATABASE_FAILURE_GRACE_MS",
    120_000
  );
  if (databaseHealthIntervalMs < 1_000 || databaseHealthIntervalMs > 60_000) {
    throw new Error("ANALYTICS_DATABASE_HEALTH_INTERVAL_MS must be between 1000 and 60000");
  }
  if (
    databaseFailureGraceMs < Math.max(
      databaseHealthIntervalMs * 2,
      MINIMUM_DATABASE_FAILURE_GRACE_MS
    ) ||
    databaseFailureGraceMs > 300_000
  ) {
    throw new Error(
      "ANALYTICS_DATABASE_FAILURE_GRACE_MS must be at least 120000, cover two health intervals, and be at most 300000"
    );
  }
  const readinessTimeoutMs = numberFromEnv(env, "ANALYTICS_READINESS_TIMEOUT_MS", 2_000);
  if (readinessTimeoutMs > 30_000) {
    throw new Error("ANALYTICS_READINESS_TIMEOUT_MS must be at most 30000");
  }
  return {
    environment,
    localnet,
    databaseUrl,
    databaseSchema: env.ANALYTICS_DATABASE_SCHEMA ?? "feather_analytics",
    deploymentIdentity,
    runtimeCustodyPath,
    runtimeCustodySha256,
    allowFixedTestPrices,
    databaseHealthIntervalMs,
    databaseFailureGraceMs,
    readinessTimeoutMs,
    shutdownTimeoutMs: numberFromEnv(env, "ANALYTICS_SHUTDOWN_TIMEOUT_MS", 10_000)
  };
}

export function assertVerifiedPostgresTls(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch (error) {
    throw new Error("ANALYTICS_DATABASE_URL must be a valid PostgreSQL URL", { cause: error });
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("ANALYTICS_DATABASE_URL must use postgres:// or postgresql://");
  }
  if (!url.hostname) throw new Error("ANALYTICS_DATABASE_URL must include a PostgreSQL hostname");
  const sslModes = url.searchParams.getAll("sslmode");
  if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
    throw new Error("ANALYTICS_DATABASE_URL must set exactly one sslmode=verify-full outside localnet");
  }
}

export class AnalyticsInfrastructureState {
  readonly #store: AnalyticsStateStore;
  readonly #requiresWriterLease: boolean;
  readonly #requiresLiveSource: boolean;
  readonly #readinessTimeoutMs: number;
  #healthcheckInFlight: Promise<boolean> | null = null;
  #reconciled = false;
  #liveSourceRunning = false;
  #stopping = false;
  #failed = false;

  constructor(options: {
    store: AnalyticsStateStore;
    requiresWriterLease: boolean;
    requiresLiveSource: boolean;
    readinessTimeoutMs?: number;
  }) {
    this.#store = options.store;
    this.#requiresWriterLease = options.requiresWriterLease;
    this.#requiresLiveSource = options.requiresLiveSource;
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.#readinessTimeoutMs) || this.#readinessTimeoutMs <= 0) {
      throw new Error("Analytics readiness timeout must be a positive integer");
    }
  }

  markReconciled(): void {
    this.#reconciled = true;
  }

  markLiveSourceRunning(): void {
    this.#liveSourceRunning = true;
  }

  markLiveSourceStopped(): void {
    this.#liveSourceRunning = false;
  }

  markFailed(): void {
    this.#failed = true;
    this.#liveSourceRunning = false;
  }

  beginShutdown(): void {
    this.#stopping = true;
  }

  livenessProbe = (): boolean => !this.#failed;

  readinessProbe = async (): Promise<boolean> => {
    if (this.#failed || this.#stopping || !this.#reconciled) return false;
    if (this.#requiresLiveSource && !this.#liveSourceRunning) return false;
    if (this.#requiresWriterLease && this.#store.hasWriterLease?.() !== true) return false;
    if (this.#store.healthcheck === undefined) return !this.#requiresWriterLease;
    return this.#storeHealthyWithinDeadline();
  };

  async #storeHealthyWithinDeadline(): Promise<boolean> {
    if (this.#store.healthcheck === undefined) return !this.#requiresWriterLease;
    if (this.#healthcheckInFlight === null) {
      const check = Promise.resolve().then(() => this.#store.healthcheck!()).then(
        () => true,
        () => false
      );
      this.#healthcheckInFlight = check;
      void check.then(() => {
        if (this.#healthcheckInFlight === check) this.#healthcheckInFlight = null;
      });
    }
    const check = this.#healthcheckInFlight;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        check,
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), this.#readinessTimeoutMs);
        })
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

export function assertAnalyticsBlockSource(
  source: unknown,
  options: { requiresLiveSource: boolean }
): asserts source is AnalyticsBlockSource {
  const candidate = source as Partial<AnalyticsBlockSource> | null;
  if (
    source === null || typeof source !== "object" ||
    typeof candidate?.fetchPage !== "function" ||
    (
      candidate.startupCursor !== undefined &&
      typeof candidate.startupCursor !== "function"
    ) ||
    (
      candidate.followLive !== undefined &&
      typeof candidate.followLive !== "function"
    )
  ) {
    throw new Error(
      "ANALYTICS_BLOCK_SOURCE_MODULE must provide fetchPage() and valid optional startupCursor()/followLive()"
    );
  }
  if (options.requiresLiveSource && candidate.followLive === undefined) {
    throw new Error("Production ANALYTICS_BLOCK_SOURCE_MODULE must provide followLive()");
  }
}

export function assertProductionPriceVerifier(
  verifier: unknown,
  options: { localnet: boolean; configured?: boolean }
): void {
  if (verifier == null) {
    if (options.configured) {
      throw new Error("ANALYTICS_PRICE_VERIFIER_MODULE must return a verifier with verify()");
    }
    if (options.localnet) return;
    throw new Error("Production ANALYTICS_PRICE_VERIFIER_MODULE must provide a price verifier");
  }
  if (typeof verifier !== "object" || typeof (verifier as Partial<PriceSampleVerifier>).verify !== "function") {
    throw new Error("ANALYTICS_PRICE_VERIFIER_MODULE must return a verifier with verify()");
  }
}

export function assertPositionSnapshotProvider(
  provider: unknown
): asserts provider is PositionSnapshotProvider {
  if (
    provider === null || typeof provider !== "object" ||
    typeof (provider as Partial<PositionSnapshotProvider>).load !== "function"
  ) {
    throw new Error("ANALYTICS_POSITION_SNAPSHOT_MODULE must return a provider with load()");
  }
}

export async function closeServerWithin(server: Server, timeoutMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Analytics shutdown timeout must be a positive integer");
  }
  let timedOut = false;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    server.close(() => finish());
  });
  return !timedOut;
}

export function createAnalyticsShutdown(options: {
  server: () => Server | null;
  store: () => AnalyticsStateStore | null;
  liveSourceSettled: () => Promise<void>;
  timeoutMs: number;
  beginShutdown: (reason: string) => void;
}): (reason?: string) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return (reason = "shutdown") => {
    if (shutdownPromise !== null) return shutdownPromise;
    options.beginShutdown(reason);
    shutdownPromise = shutdownAnalyticsRuntime({
      server: options.server(),
      store: options.store(),
      liveSourceSettled: options.liveSourceSettled(),
      timeoutMs: options.timeoutMs
    });
    return shutdownPromise;
  };
}

export async function superviseAnalyticsFatalFailure(options: {
  failure: Promise<Error>;
  isStopping: () => boolean;
  markFailed: () => void;
  shutdown: (reason: string) => Promise<void>;
  report: (message: string) => void;
  setExitCode: (code: number) => void;
  terminate?: (code: number) => void;
  reason: string;
  label: string;
}): Promise<void> {
  const error = await options.failure;
  if (options.isStopping()) return;
  options.markFailed();
  options.setExitCode(1);
  options.report(`${options.label}: ${error instanceof Error ? error.message : String(error)}`);
  try {
    await options.shutdown(options.reason);
  } catch (shutdownError) {
    options.report(
      `Analytics shutdown after ${options.reason} failed: ${
        shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
      }`
    );
  } finally {
    options.terminate?.(1);
  }
}

export function createCoalescedStoreHealthProbe(
  healthcheck: () => Promise<void>
): (timeoutMs: number) => Promise<boolean> {
  let inFlight: Promise<void> | null = null;
  return async (timeoutMs: number): Promise<boolean> => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Analytics database health probe timeout must be a positive integer");
    }
    if (inFlight === null) {
      const check = Promise.resolve().then(healthcheck);
      inFlight = check;
      void check.then(
        () => { if (inFlight === check) inFlight = null; },
        () => { if (inFlight === check) inFlight = null; }
      );
    }
    const check = inFlight;
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        check.then(() => true, () => false),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        })
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

export async function waitForSustainedDatabaseHealthFailure(options: {
  probe: () => Promise<boolean>;
  signal: AbortSignal;
  intervalMs: number;
  failureGraceMs: number;
  now?: () => number;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<Error | null> {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error("Analytics database health interval must be a positive integer");
  }
  if (!Number.isSafeInteger(options.failureGraceMs) || options.failureGraceMs < options.intervalMs * 2) {
    throw new Error("Analytics database failure grace must cover at least two health intervals");
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForAbortableDelay;
  let failureStartedAt: number | null = null;
  while (!options.signal.aborted) {
    const healthy = await options.probe();
    const observedAt = now();
    if (healthy) {
      failureStartedAt = null;
    } else {
      failureStartedAt ??= observedAt;
      if (observedAt - failureStartedAt >= options.failureGraceMs) {
        return new Error(
          `Analytics PostgreSQL healthcheck failed continuously for at least ${options.failureGraceMs}ms`
        );
      }
    }
    if (options.signal.aborted) return null;
    try {
      await wait(options.intervalMs, options.signal);
    } catch (error) {
      if (options.signal.aborted) return null;
      throw error;
    }
  }
  return null;
}

export async function shutdownAnalyticsRuntime(options: {
  server: Server | null;
  store: AnalyticsStateStore | null;
  liveSourceSettled: Promise<void>;
  timeoutMs: number;
}): Promise<void> {
  const started = Date.now();
  const sourceAndServerBudget = Math.max(1, Math.floor(options.timeoutMs * 0.75));
  let drainError: unknown;
  try {
    const drains: Promise<unknown>[] = [settleWithin(options.liveSourceSettled, sourceAndServerBudget)];
    if (options.server !== null) drains.push(closeServerWithin(options.server, sourceAndServerBudget));
    await Promise.all(drains);
  } catch (error) {
    drainError = error;
  }

  const remaining = Math.max(1, options.timeoutMs - (Date.now() - started));
  let closeError: unknown;
  try {
    if (options.store?.close !== undefined) {
      await settleWithin(options.store.close(), remaining);
    }
  } catch (error) {
    closeError = error;
  }

  if (drainError !== undefined && closeError !== undefined) {
    throw new AggregateError([drainError, closeError], "Analytics shutdown failed");
  }
  if (closeError !== undefined) throw closeError;
  if (drainError !== undefined) throw drainError;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timeout = setTimeout(() => finish(), timeoutMs);
    void promise.then(() => finish(), finish);
  });
}

async function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function numberFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function booleanFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`${name} must be 1 or 0`);
}

export function strictBooleanFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error(`${name} must be exactly true, false, 1, or 0`);
}

function nonEmptyOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}
