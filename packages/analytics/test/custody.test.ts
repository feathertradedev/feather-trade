import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  verifiedModuleDataUrl,
  verifyAnalyticsRuntimeCustody
} from "../src/index.js";

const IDENTITY = "mainnet:0123456789abcdef";

test("production runtime custody verifies canonical inventory and imports verified bytes", async () => {
  const fixture = await custodyFixture();
  try {
    const verified = await verifyAnalyticsRuntimeCustody(fixture.options);
    assert.equal(verified.deploymentIdentity, IDENTITY);
    assert.equal(verified.files.pricePolicies.contents.toString("utf8"), "[]\n");
    await writeFile(
      fixture.paths.priceVerifierModule,
      "export const custodyMarker = 'post-verification-path-mutation';\n"
    );
    const loaded = await import(verifiedModuleDataUrl(verified.files.priceVerifierModule)) as {
      custodyMarker: string;
    };
    assert.equal(
      loaded.custodyMarker,
      "price-verifier",
      "module import uses the verified held bytes rather than reopening the mutable path"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("production runtime custody rejects mutation, symlinks, identity drift, and noncanonical inventories", async () => {
  const fixture = await custodyFixture();
  try {
    await writeFile(fixture.paths.blockSourceModule, "export const custodyMarker = 'mutated';\n");
    await assert.rejects(
      () => verifyAnalyticsRuntimeCustody(fixture.options),
      /SHA-256 mismatch for blockSourceModule/
    );

    const restored = "export const custodyMarker = 'block-source';\n";
    await writeFile(fixture.paths.blockSourceModule, restored);
    const symlinkPath = join(fixture.root, "block-source-link.mjs");
    await symlink(fixture.paths.blockSourceModule, symlinkPath);
    const symlinkInventory = inventory({ ...fixture.paths, blockSourceModule: symlinkPath }, {
      ...fixture.hashes,
      blockSourceModule: sha256(Buffer.from(restored))
    });
    await writeFile(fixture.inventoryPath, canonicalJson(symlinkInventory));
    await assert.rejects(
      () => verifyAnalyticsRuntimeCustody({
        ...fixture.options,
        inventorySha256: sha256(Buffer.from(canonicalJson(symlinkInventory))),
        expectedPaths: { ...fixture.paths, blockSourceModule: symlinkPath }
      }),
      /must be an existing non-symlink file/
    );

    const canonical = canonicalJson(inventory(fixture.paths, fixture.hashes));
    await writeFile(fixture.inventoryPath, canonical);
    await assert.rejects(
      () => verifyAnalyticsRuntimeCustody({
        ...fixture.options,
        inventorySha256: sha256(Buffer.from(canonical)),
        deploymentIdentity: "mainnet:different"
      }),
      /deployment identity does not match/
    );

    const noncanonical = JSON.stringify(JSON.parse(canonical));
    await writeFile(fixture.inventoryPath, noncanonical);
    await assert.rejects(
      () => verifyAnalyticsRuntimeCustody({
        ...fixture.options,
        inventorySha256: sha256(Buffer.from(noncanonical))
      }),
      /not in canonical deterministic form/
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function custodyFixture(): Promise<{
  root: string;
  inventoryPath: string;
  paths: Record<"pricePolicies" | "priceVerifierModule" | "blockSourceModule" | "positionSnapshotModule", string>;
  hashes: Record<"pricePolicies" | "priceVerifierModule" | "blockSourceModule" | "positionSnapshotModule", string>;
  options: Parameters<typeof verifyAnalyticsRuntimeCustody>[0];
}> {
  const root = await mkdtemp(join(tmpdir(), "feather-analytics-custody-"));
  const paths = {
    pricePolicies: join(root, "price-policies.json"),
    priceVerifierModule: join(root, "price-verifier.mjs"),
    blockSourceModule: join(root, "block-source.mjs"),
    positionSnapshotModule: join(root, "position-snapshot.mjs")
  };
  const contents = {
    pricePolicies: "[]\n",
    priceVerifierModule: "export const custodyMarker = 'price-verifier';\n",
    blockSourceModule: "export const custodyMarker = 'block-source';\n",
    positionSnapshotModule: "export const custodyMarker = 'position-snapshot';\n"
  };
  await Promise.all(Object.entries(paths).map(([role, path]) => writeFile(
    path,
    contents[role as keyof typeof contents]
  )));
  const hashes = Object.fromEntries(Object.entries(contents).map(([role, value]) => [
    role,
    sha256(Buffer.from(value))
  ])) as Record<keyof typeof paths, string>;
  const serialized = canonicalJson(inventory(paths, hashes));
  const inventoryPath = join(root, "runtime-custody.json");
  await writeFile(inventoryPath, serialized);
  return {
    root,
    inventoryPath,
    paths,
    hashes,
    options: {
      inventoryPath,
      inventorySha256: sha256(Buffer.from(serialized)),
      deploymentIdentity: IDENTITY,
      environment: "mainnet",
      expectedPaths: paths
    }
  };
}

function inventory(
  paths: Record<string, string>,
  hashes: Record<string, string>
): object {
  return {
    version: 1,
    deploymentIdentity: IDENTITY,
    environment: "mainnet",
    files: {
      pricePolicies: { path: paths.pricePolicies, sha256: hashes.pricePolicies },
      priceVerifierModule: { path: paths.priceVerifierModule, sha256: hashes.priceVerifierModule },
      blockSourceModule: { path: paths.blockSourceModule, sha256: hashes.blockSourceModule },
      positionSnapshotModule: { path: paths.positionSnapshotModule, sha256: hashes.positionSnapshotModule }
    }
  };
}

function canonicalJson(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
