import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SEPOLIA_CHAIN_ID, SEPOLIA_USDC, SEPOLIA_WETH } from "../src/chains.js";
import {
  assertSepoliaRuntimeManifest,
  readDeploymentManifest,
  type GenericEvmDeploymentManifest
} from "../src/manifest.js";
import { registryFromSepoliaManifest } from "../src/registry.js";
import { findTokenBySymbol, sepoliaTokenListFromManifest } from "../src/tokens.js";

const publicManifestPath = new URL("../../../../deployments/evm/sepolia/public.json", import.meta.url);

test("loads the sealed Sepolia runtime manifest and canonical token identities", () => {
  const manifest = readDeploymentManifest(publicManifestPath.pathname);
  assert.equal(manifest.schemaVersion, "lb.evm.v1");
  assertSepoliaRuntimeManifest(manifest);

  const registry = registryFromSepoliaManifest(manifest);
  assert.equal(registry.environment, "sepolia");
  assert.equal(registry.chainId, SEPOLIA_CHAIN_ID);
  assert.deepEqual(registry.chain.rpcUrls.default.http, [manifest.endpoints.rpcUrl]);
  assert.deepEqual(registry.chain.rpcUrls.public?.http, [manifest.endpoints.rpcUrl]);
  assert.equal(registry.supportedPairImplementations[0], manifest.contracts.lbPairImplementation);

  const weth = findTokenBySymbol(registry.tokens, "WETH");
  const usdc = findTokenBySymbol(registry.tokens, "USDC");
  assert.equal(weth?.address, SEPOLIA_WETH);
  assert.equal(weth?.risk.reviewStatus, "standard");
  assert.equal(usdc?.address, SEPOLIA_USDC);
  assert.equal(usdc?.decimals, 6);
  assert.equal(usdc?.risk.reviewStatus, "restricted");
  assert.deepEqual(usdc?.risk.flags, ["upgradeable", "blacklistable"]);
  assert.equal(Object.values(registry.tokens).some((token) => token.tags.includes("mock")), false);
});

test("accepts an endpoint-free generic deployment artifact but rejects it as a public runtime manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "feather-sepolia-manifest-"));
  const path = join(dir, "latest.json");
  try {
    const raw = JSON.parse(readFileSync(publicManifestPath, "utf8")) as Record<string, unknown>;
    delete raw.endpoints;
    writeFileSync(path, `${JSON.stringify(raw)}\n`);

    const manifest = readDeploymentManifest(path);
    assert.equal(manifest.schemaVersion, "lb.evm.v1");
    assert.equal(manifest.endpoints, undefined);
    assert.throws(() => assertSepoliaRuntimeManifest(manifest), /requires endpoints\.rpcUrl/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Sepolia runtime refinement pins the chain and quote-token allowlist", () => {
  const manifest = readDeploymentManifest(publicManifestPath.pathname);
  assert.equal(manifest.schemaVersion, "lb.evm.v1");
  assertSepoliaRuntimeManifest(manifest);

  const wrongChain = { ...manifest, chainId: 1 } as GenericEvmDeploymentManifest;
  assert.throws(() => assertSepoliaRuntimeManifest(wrongChain), /chainId 11155111/);

  const missingUsdc = {
    ...manifest,
    quoteAssets: {
      ...manifest.quoteAssets,
      extra0: "0x0000000000000000000000000000000000000000"
    }
  } as typeof manifest;
  assert.throws(() => sepoliaTokenListFromManifest(missingUsdc), /USDC is not declared/);

  const wrongWrappedNative = {
    ...manifest,
    tokens: { wrappedNative: "0x1000000000000000000000000000000000000001" },
    quoteAssets: {
      ...manifest.quoteAssets,
      wrappedNative: "0x1000000000000000000000000000000000000001"
    }
  } as typeof manifest;
  assert.throws(() => sepoliaTokenListFromManifest(wrongWrappedNative), /does not match the canonical WETH/);
});
