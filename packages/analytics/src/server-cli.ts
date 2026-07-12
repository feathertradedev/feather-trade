import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { AnalyticsEngine } from "./engine.js";
import {
  AnalyticsApiService,
  AnalyticsCheckpointStore,
  startAnalyticsHttpServer,
  type AnalyticsBlockSource,
  type PositionSnapshotProvider,
  type PriceSampleVerifier
} from "./service.js";
import type { PricePolicy } from "./types.js";

const policyPath = process.env.ANALYTICS_PRICE_POLICIES;
if (!policyPath) throw new Error("ANALYTICS_PRICE_POLICIES must point to a JSON PricePolicy array");

const policies = JSON.parse(await readFile(policyPath, "utf8")) as PricePolicy[];
const engine = new AnalyticsEngine(policies, {
  maxHeadLagSeconds: numberFromEnv("ANALYTICS_MAX_HEAD_LAG_SECONDS", 120),
  maxPositionSnapshotAgeSeconds: numberFromEnv("ANALYTICS_MAX_POSITION_SNAPSHOT_AGE_SECONDS", 300)
});
const store = new AnalyticsCheckpointStore(process.env.ANALYTICS_STATE_PATH ?? ".local/analytics/checkpoint.json");
const allowFixedTestPrices = booleanFromEnv("ANALYTICS_ALLOW_FIXED_TEST_PRICES", false);
if (allowFixedTestPrices && process.env.ANALYTICS_ENVIRONMENT !== "localnet") {
  throw new Error("ANALYTICS_ALLOW_FIXED_TEST_PRICES requires ANALYTICS_ENVIRONMENT=localnet");
}
const priceVerifier = await loadPriceVerifier(process.env.ANALYTICS_PRICE_VERIFIER_MODULE ?? null);
const positionSnapshotProvider = await loadPositionSnapshotProvider(
  process.env.ANALYTICS_POSITION_SNAPSHOT_MODULE ?? null
);
if (positionSnapshotProvider === null) {
  throw new Error("ANALYTICS_POSITION_SNAPSHOT_MODULE is required for head-exact wallet accounting");
}
const service = await AnalyticsApiService.create({
  engine,
  store,
  allowFixedTestPrices,
  priceVerifier,
  positionSnapshotProvider
});
const blockSource = await loadBlockSource(process.env.ANALYTICS_BLOCK_SOURCE_MODULE ?? null);
const initialHealth = service.getHealth();
const coverageComplete =
  initialHealth.backfillStatus === "complete" &&
  initialHealth.coverageStartTimestamp !== null &&
  initialHealth.coverageThroughTimestamp !== null &&
  (initialHealth.headTimestamp === null || initialHealth.coverageThroughTimestamp >= initialHealth.headTimestamp);
if (!coverageComplete) {
  if (blockSource === null) {
    throw new Error("ANALYTICS_BLOCK_SOURCE_MODULE is required until canonical backfill is complete");
  }
  const result = await service.backfill(blockSource.fetchPage, {
    startCursor: initialHealth.backfillCursor,
    maxPages: numberFromEnv("ANALYTICS_BACKFILL_MAX_PAGES", 10_000)
  });
  if (result.status !== "complete") {
    throw new Error(`Analytics backfill stopped ${result.status} at ${result.cursor ?? "start"}: ${result.error ?? "page cap"}`);
  }
}
const host = process.env.ANALYTICS_HOST ?? "127.0.0.1";
const port = numberFromEnv("ANALYTICS_PORT", 8787);
await startAnalyticsHttpServer({
  service,
  host,
  port,
  ingestToken: process.env.ANALYTICS_INGEST_TOKEN ?? null,
  corsOrigins: commaSeparatedEnv("ANALYTICS_CORS_ORIGINS")
});
process.stdout.write(`Feather analytics listening on http://${host}:${port}\n`);
if (blockSource?.followLive) {
  void blockSource.followLive((block) => service.ingestBlock(block)).catch((error: unknown) => {
    process.stderr.write(`Analytics live source failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function commaSeparatedEnv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error(`${name} must be 1 or 0`);
}

async function loadPriceVerifier(modulePath: string | null): Promise<PriceSampleVerifier | null> {
  if (modulePath === null) return null;
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    createPriceVerifier?: () => PriceSampleVerifier | Promise<PriceSampleVerifier>;
  };
  if (typeof loaded.createPriceVerifier !== "function") {
    throw new Error("ANALYTICS_PRICE_VERIFIER_MODULE must export createPriceVerifier()");
  }
  return loaded.createPriceVerifier();
}

async function loadBlockSource(modulePath: string | null): Promise<AnalyticsBlockSource | null> {
  if (modulePath === null) return null;
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    createBlockSource?: () => AnalyticsBlockSource | Promise<AnalyticsBlockSource>;
  };
  if (typeof loaded.createBlockSource !== "function") {
    throw new Error("ANALYTICS_BLOCK_SOURCE_MODULE must export createBlockSource()");
  }
  return loaded.createBlockSource();
}

async function loadPositionSnapshotProvider(modulePath: string | null): Promise<PositionSnapshotProvider | null> {
  if (modulePath === null) return null;
  const loaded = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    createPositionSnapshotProvider?: () => PositionSnapshotProvider | Promise<PositionSnapshotProvider>;
  };
  if (typeof loaded.createPositionSnapshotProvider !== "function") {
    throw new Error("ANALYTICS_POSITION_SNAPSHOT_MODULE must export createPositionSnapshotProvider()");
  }
  return loaded.createPositionSnapshotProvider();
}
