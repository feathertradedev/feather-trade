import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const CUSTODY_ROLES = [
  "pricePolicies",
  "priceVerifierModule",
  "blockSourceModule",
  "positionSnapshotModule"
] as const;

export type AnalyticsRuntimeCustodyRole = typeof CUSTODY_ROLES[number];

export interface VerifiedAnalyticsRuntimeFile {
  path: string;
  sha256: string;
  contents: Buffer;
}

export interface VerifiedAnalyticsRuntimeCustody {
  deploymentIdentity: string;
  environment: "testnet" | "mainnet";
  inventoryPath: string;
  inventorySha256: string;
  files: Record<AnalyticsRuntimeCustodyRole, VerifiedAnalyticsRuntimeFile>;
}

interface CustodyFileEntry {
  path: string;
  sha256: string;
}

interface CustodyInventory {
  version: 1;
  deploymentIdentity: string;
  environment: "testnet" | "mainnet";
  files: Record<AnalyticsRuntimeCustodyRole, CustodyFileEntry>;
}

export async function verifyAnalyticsRuntimeCustody(options: {
  inventoryPath: string;
  inventorySha256: string;
  deploymentIdentity: string;
  environment: "testnet" | "mainnet";
  expectedPaths: Record<AnalyticsRuntimeCustodyRole, string>;
}): Promise<VerifiedAnalyticsRuntimeCustody> {
  const inventoryPath = absolutePath(options.inventoryPath, "ANALYTICS_RUNTIME_CUSTODY");
  const expectedInventorySha256 = sha256Value(
    options.inventorySha256,
    "ANALYTICS_RUNTIME_CUSTODY_SHA256"
  );
  const inventoryBytes = await readStableRegularFile(inventoryPath, "analytics runtime custody inventory");
  const actualInventorySha256 = sha256(inventoryBytes);
  if (actualInventorySha256 !== expectedInventorySha256) {
    throw new Error("Analytics runtime custody inventory SHA-256 does not match ANALYTICS_RUNTIME_CUSTODY_SHA256");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inventoryBytes.toString("utf8"));
  } catch (error) {
    throw new Error("Analytics runtime custody inventory must be valid JSON", { cause: error });
  }
  const inventory = parseInventory(parsed);
  const canonical = `${JSON.stringify(inventory, null, 2)}\n`;
  if (!inventoryBytes.equals(Buffer.from(canonical))) {
    throw new Error("Analytics runtime custody inventory is not in canonical deterministic form");
  }
  if (inventory.environment !== options.environment) {
    throw new Error("Analytics runtime custody environment does not match ANALYTICS_ENVIRONMENT");
  }
  if (inventory.deploymentIdentity !== options.deploymentIdentity) {
    throw new Error("Analytics runtime custody deployment identity does not match ANALYTICS_DEPLOYMENT_IDENTITY");
  }

  const verified = {} as Record<AnalyticsRuntimeCustodyRole, VerifiedAnalyticsRuntimeFile>;
  for (const role of CUSTODY_ROLES) {
    const entry = inventory.files[role];
    const expectedPath = absolutePath(options.expectedPaths[role], environmentNameForRole(role));
    const inventoryFilePath = absolutePath(entry.path, `custody file ${role}`);
    if (resolve(inventoryFilePath) !== resolve(expectedPath)) {
      throw new Error(`Analytics runtime custody path for ${role} does not match its configured runtime path`);
    }
    const expectedSha256 = sha256Value(entry.sha256, `custody file ${role} SHA-256`);
    const contents = await readStableRegularFile(inventoryFilePath, `analytics runtime ${role}`);
    if (sha256(contents) !== expectedSha256) {
      throw new Error(`Analytics runtime custody SHA-256 mismatch for ${role}`);
    }
    verified[role] = { path: inventoryFilePath, sha256: expectedSha256, contents };
  }

  return {
    deploymentIdentity: inventory.deploymentIdentity,
    environment: inventory.environment,
    inventoryPath,
    inventorySha256: actualInventorySha256,
    files: verified
  };
}

export function verifiedModuleDataUrl(file: VerifiedAnalyticsRuntimeFile): string {
  return `data:text/javascript;base64,${file.contents.toString("base64")}#sha256=${file.sha256}`;
}

function parseInventory(value: unknown): CustodyInventory {
  if (!isPlainObject(value)) throw new Error("Analytics runtime custody inventory must be an object");
  if (value.version !== 1) throw new Error("Analytics runtime custody inventory version must be 1");
  const deploymentIdentity = nonEmptyString(value.deploymentIdentity, "custody deploymentIdentity");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(deploymentIdentity)) {
    throw new Error("Analytics runtime custody deploymentIdentity is invalid");
  }
  if (value.environment !== "testnet" && value.environment !== "mainnet") {
    throw new Error("Analytics runtime custody environment must be testnet or mainnet");
  }
  if (!isPlainObject(value.files)) throw new Error("Analytics runtime custody files must be an object");

  const files = {} as Record<AnalyticsRuntimeCustodyRole, CustodyFileEntry>;
  for (const role of CUSTODY_ROLES) {
    const candidate = value.files[role];
    if (!isPlainObject(candidate)) throw new Error(`Analytics runtime custody file ${role} is required`);
    files[role] = {
      path: nonEmptyString(candidate.path, `custody file ${role} path`),
      sha256: sha256Value(candidate.sha256, `custody file ${role} SHA-256`)
    };
  }

  return {
    version: 1,
    deploymentIdentity,
    environment: value.environment,
    files
  };
}

async function readStableRegularFile(path: string, label: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be an existing non-symlink file`, { cause: error });
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
      contents.byteLength !== after.size
    ) {
      throw new Error(`${label} changed while its custody hash was being verified`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function absolutePath(value: string, label: string): string {
  const path = value.trim();
  if (!path || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return path;
}

function sha256Value(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function environmentNameForRole(role: AnalyticsRuntimeCustodyRole): string {
  switch (role) {
    case "pricePolicies": return "ANALYTICS_PRICE_POLICIES";
    case "priceVerifierModule": return "ANALYTICS_PRICE_VERIFIER_MODULE";
    case "blockSourceModule": return "ANALYTICS_BLOCK_SOURCE_MODULE";
    case "positionSnapshotModule": return "ANALYTICS_POSITION_SNAPSHOT_MODULE";
  }
}
