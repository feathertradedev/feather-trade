#!/usr/bin/env node
const { existsSync, readFileSync, readdirSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../..");
const tokenListDir = join(repoRoot, "packages/sdk/src/token-lists");
const publicDir = join(repoRoot, "apps/web/public");
const allowedChainIdsByEnvironment = new Map([
  ["localnet", 31_337],
  ["robinhoodTestnet", 46_630],
  ["robinhood", 4_663],
  ["sepolia", 11_155_111]
]);
const allowedAddressRefsByEnvironment = new Map([
  ["localnet", new Set(["tokens.wnative", "tokens.usdc", "tokens.usdt", "tokens.weth"])]
]);
const allowedTags = new Set(["canonical", "localnet", "mainnet", "mock", "quote", "stablecoin", "testnet", "wrapped-native"]);
const allowedRiskFlags = new Set(["fee-on-transfer", "rebasing", "blacklistable", "upgradeable", "suspicious"]);
const allowedReviewStatuses = new Set(["standard", "restricted", "blocked"]);
const allowedTokenActions = new Set(["swap", "add-liquidity", "remove-liquidity"]);
const allowedApprovalBehaviors = new Set(["standard-bool", "returns-false", "no-return", "zero-reset-required"]);
const blockedTokenActions = [...allowedTokenActions];
const publicEnvironments = new Set(["robinhood", "robinhoodTestnet", "sepolia"]);
const publicManifestByEnvironment = new Map([
  ["robinhood", "deployments/examples/robinhood-mainnet.example.json"],
  ["robinhoodTestnet", "deployments/examples/robinhood-testnet.example.json"],
  ["sepolia", "deployments/evm/sepolia/public.json"]
]);
const webDefaultManifestByEnvironment = new Map([
  ["robinhood", "robinhoodDefaultManifest"],
  ["robinhoodTestnet", "robinhoodTestnetDefaultManifest"],
  ["sepolia", "sepoliaDefaultManifest"]
]);
const webDefaultManifestsPath = "apps/web/src/default-manifests.ts";
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const zeroAddress = "0x0000000000000000000000000000000000000000";

function main() {
  const args = process.argv.slice(2);
  const files =
    args.length > 0
      ? args.map((file) => resolve(repoRoot, file))
      : readdirSync(tokenListDir)
          .filter((file) => file.endsWith(".json") && file !== "schema.json")
          .sort()
          .map((file) => join(tokenListDir, file));

  const errors = files.flatMap(validateFile);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }

    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${files.length} token list${files.length === 1 ? "" : "s"}.`);
}

function validateFile(file) {
  const displayPath = relative(repoRoot, file);
  const errors = [];
  let value;

  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return [`${displayPath}: invalid JSON: ${error.message}`];
  }

  if (!isObject(value)) {
    return [`${displayPath}: token list must be a JSON object`];
  }

  expectString(value.schemaVersion, `${displayPath}.schemaVersion`, errors);
  expectString(value.environment, `${displayPath}.environment`, errors);
  expectNumber(value.chainId, `${displayPath}.chainId`, errors);
  expectString(value.name, `${displayPath}.name`, errors);
  expectDate(value.updatedAt, `${displayPath}.updatedAt`, errors);

  if (value.schemaVersion !== "lb.token-list.v1") {
    errors.push(`${displayPath}.schemaVersion: unsupported schemaVersion ${format(value.schemaVersion)}`);
  }

  const expectedChainId = allowedChainIdsByEnvironment.get(value.environment);
  if (expectedChainId === undefined) {
    errors.push(`${displayPath}.environment: unsupported environment ${format(value.environment)}`);
  } else if (value.chainId !== expectedChainId) {
    errors.push(`${displayPath}.chainId: expected ${expectedChainId} for ${value.environment}, got ${format(value.chainId)}`);
  }

  if (!Array.isArray(value.tokens) || value.tokens.length === 0) {
    errors.push(`${displayPath}.tokens: expected a non-empty token array`);
    return errors;
  }

  const seenIds = new Map();
  const seenAddresses = new Map();
  const seenRefs = new Map();
  const quoteTokens = [];

  value.tokens.forEach((token, index) => {
    const path = `${displayPath}.tokens[${index}]`;

    if (!isObject(token)) {
      errors.push(`${path}: expected token object`);
      return;
    }

    expectId(token.id, `${path}.id`, errors);
    expectString(token.symbol, `${path}.symbol`, errors);
    expectString(token.name, `${path}.name`, errors);
    if (typeof token.approvalBehavior !== "string" || !allowedApprovalBehaviors.has(token.approvalBehavior)) {
      errors.push(`${path}.approvalBehavior: expected an explicit supported approval behavior`);
    }
    expectInteger(token.decimals, `${path}.decimals`, errors);
    expectLogoURI(token.logoURI, `${path}.logoURI`, errors);
    expectTags(token.tags, `${path}.tags`, errors);
    expectRiskPolicy(value.environment, token, path, errors);
    expectEnvironmentPolicy(value.environment, token, path, errors);
    expectLogoAsset(token.logoURI, `${path}.logoURI`, errors);

    if ("address" in token && "addressRef" in token) {
      errors.push(`${path}: specify exactly one of address or addressRef`);
    } else if ("address" in token) {
      expectAddress(token.address, `${path}.address`, errors);
      addDuplicateCheck(seenAddresses, String(token.address).toLowerCase(), path, "address", errors);
    } else if ("addressRef" in token) {
      const refs = allowedAddressRefsByEnvironment.get(value.environment);
      if (typeof token.addressRef !== "string" || refs === undefined || !refs.has(token.addressRef)) {
        errors.push(`${path}.addressRef: unsupported addressRef ${format(token.addressRef)} for ${format(value.environment)}`);
      }

      addDuplicateCheck(seenRefs, token.addressRef, path, "addressRef", errors);
    } else {
      errors.push(`${path}: missing address or addressRef`);
    }

    if (Array.isArray(token.tags) && token.tags.includes("quote")) {
      quoteTokens.push({ token, path });
    }

    addDuplicateCheck(seenIds, token.id, path, "id", errors);
  });

  if (value.environment === "robinhood") {
    if (quoteTokens.length !== 1) {
      errors.push(`${displayPath}.tokens: expected exactly one production quote token for robinhood, got ${quoteTokens.length}`);
    }

    for (const { token, path } of quoteTokens) {
      if (!Array.isArray(token.tags) || !token.tags.includes("stablecoin") || !token.tags.includes("canonical")) {
        errors.push(`${path}.tags: production quote token must be canonical and stablecoin`);
      }
    }
  }

  if (publicEnvironments.has(value.environment)) {
    expectPublicQuoteTokensInManifest(value.environment, displayPath, quoteTokens, errors);
    expectPublicQuoteTokensInWebDefaults(value.environment, displayPath, quoteTokens, errors);
  }

  return errors;
}

function addDuplicateCheck(seen, key, path, field, errors) {
  if (typeof key !== "string" || key.length === 0) {
    return;
  }

  const previous = seen.get(key);
  if (previous !== undefined) {
    errors.push(`${path}.${field}: duplicate ${field}; first seen at ${previous}.${field}`);
    return;
  }

  seen.set(key, path);
}

function expectAddress(value, path, errors) {
  if (typeof value !== "string" || !addressPattern.test(value) || value.toLowerCase() === zeroAddress) {
    errors.push(`${path}: expected a non-zero EVM address`);
  }
}

function expectDate(value, path, errors) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    errors.push(`${path}: expected YYYY-MM-DD date`);
  }
}

function expectId(value, path, errors) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    errors.push(`${path}: expected lowercase kebab-case id`);
  }
}

function expectInteger(value, path, errors) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    errors.push(`${path}: expected integer decimals between 0 and 255`);
  }
}

function expectLogoURI(value, path, errors) {
  if (typeof value !== "string" || !/^\/token-assets\/[a-z0-9-]+\.svg$/.test(value)) {
    errors.push(`${path}: expected /token-assets/<id>.svg`);
  }
}

function expectLogoAsset(value, path, errors) {
  if (typeof value !== "string" || !/^\/token-assets\/[a-z0-9-]+\.svg$/.test(value)) {
    return;
  }

  const logoPath = join(publicDir, value.replace(/^\/+/, ""));
  if (!existsSync(logoPath)) {
    errors.push(`${path}: missing public asset ${relative(repoRoot, logoPath)}`);
    return;
  }

  const svg = readFileSync(logoPath, "utf8");
  if (!svg.includes("<svg") || /<script/i.test(svg)) {
    errors.push(`${path}: expected safe SVG asset at ${relative(repoRoot, logoPath)}`);
  }
}

function expectNumber(value, path, errors) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(`${path}: expected number`);
  }
}

function expectString(value, path, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${path}: expected non-empty string`);
  }
}

function expectEnvironmentPolicy(environment, token, path, errors) {
  if (!publicEnvironments.has(environment)) {
    return;
  }

  if (Array.isArray(token.tags)) {
    if (token.tags.includes("localnet")) {
      errors.push(`${path}.tags: public token lists must not include localnet tokens`);
    }

    if (token.tags.includes("mock")) {
      errors.push(`${path}.tags: public token lists must not include mock tokens`);
    }
  }

  if (typeof token.name === "string" && /\bmock\b/i.test(token.name)) {
    errors.push(`${path}.name: public token lists must not label tokens as mock assets`);
  }
}

function expectRiskPolicy(environment, token, path, errors) {
  if (token.risk === undefined) {
    if (publicEnvironments.has(environment)) {
      errors.push(`${path}.risk: public tokens must include token-risk policy metadata`);
    }
    return;
  }

  if (!isObject(token.risk)) {
    errors.push(`${path}.risk: expected token-risk policy object`);
    return;
  }

  const risk = token.risk;
  for (const key of Object.keys(risk)) {
    if (!["reviewStatus", "flags", "disabledActions", "notes"].includes(key)) {
      errors.push(`${path}.risk.${key}: unsupported token-risk policy field`);
    }
  }

  if (typeof risk.reviewStatus !== "string" || !allowedReviewStatuses.has(risk.reviewStatus)) {
    errors.push(`${path}.risk.reviewStatus: expected one of ${[...allowedReviewStatuses].join(", ")}`);
  }

  expectStringArrayMembers(risk.flags, `${path}.risk.flags`, allowedRiskFlags, errors);
  expectStringArrayMembers(risk.disabledActions, `${path}.risk.disabledActions`, allowedTokenActions, errors);

  if ("notes" in risk && (typeof risk.notes !== "string" || risk.notes.length === 0)) {
    errors.push(`${path}.risk.notes: expected non-empty string when present`);
  }

  const flags = Array.isArray(risk.flags) ? risk.flags : [];
  const disabledActions = Array.isArray(risk.disabledActions) ? risk.disabledActions : [];

  if (risk.reviewStatus === "standard") {
    if (flags.length > 0) {
      errors.push(`${path}.risk.flags: standard tokens must not carry risky flags`);
    }
    if (disabledActions.length > 0) {
      errors.push(`${path}.risk.disabledActions: standard tokens must not disable actions`);
    }
  }

  if (risk.reviewStatus === "blocked") {
    for (const action of blockedTokenActions) {
      if (!disabledActions.includes(action)) {
        errors.push(`${path}.risk.disabledActions: blocked tokens must disable ${action}`);
      }
    }
  }

  if (Array.isArray(token.tags) && token.tags.includes("quote") && risk.reviewStatus === "blocked") {
    errors.push(`${path}.risk.reviewStatus: quote tokens must be standard or restricted, not blocked`);
  }

}

function expectStringArrayMembers(value, path, allowedValues, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected array`);
    return;
  }

  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !allowedValues.has(item)) {
      errors.push(`${path}: unsupported value ${format(item)}`);
    } else if (seen.has(item)) {
      errors.push(`${path}: duplicate value ${item}`);
    }

    seen.add(item);
  }
}

function expectPublicQuoteTokensInManifest(environment, displayPath, quoteTokens, errors) {
  if (quoteTokens.length === 0) {
    return;
  }

  const quoteAssets = manifestQuoteAssets(environment, errors);
  if (quoteAssets === null) {
    return;
  }

  for (const { token, path } of quoteTokens) {
    if (typeof token.address !== "string" || !addressPattern.test(token.address)) {
      continue;
    }

    if (!quoteAssets.addresses.has(token.address.toLowerCase())) {
      errors.push(
        `${path}.address: quote token must be present in ${quoteAssets.displayPath}.quoteAssets (${displayPath})`
      );
    }
  }
}

function expectPublicQuoteTokensInWebDefaults(environment, displayPath, quoteTokens, errors) {
  if (quoteTokens.length === 0) {
    return;
  }

  const quoteAssets = webDefaultQuoteAssets(environment, errors);
  if (quoteAssets === null) {
    return;
  }

  for (const { token, path } of quoteTokens) {
    if (typeof token.address !== "string" || !addressPattern.test(token.address)) {
      continue;
    }

    if (!quoteAssets.addresses.has(token.address.toLowerCase())) {
      errors.push(
        `${path}.address: quote token must be present in ${quoteAssets.displayPath}.${quoteAssets.exportName}.quoteAssets (${displayPath})`
      );
    }
  }
}

function manifestQuoteAssets(environment, errors) {
  const manifestRelativePath = publicManifestByEnvironment.get(environment);
  if (!manifestRelativePath) {
    errors.push(`${environment}: missing public manifest mapping for quote-asset validation`);
    return null;
  }

  const manifestPath = join(repoRoot, manifestRelativePath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    errors.push(`${manifestRelativePath}: unable to read quote-asset manifest: ${error.message}`);
    return null;
  }

  if (!isObject(manifest.quoteAssets)) {
    errors.push(`${manifestRelativePath}.quoteAssets: expected quote asset object`);
    return null;
  }

  const addresses = new Set();
  for (const [key, value] of Object.entries(manifest.quoteAssets)) {
    if (typeof value === "string" && addressPattern.test(value) && value.toLowerCase() !== zeroAddress) {
      addresses.add(value.toLowerCase());
    } else if (typeof value !== "string" || !addressPattern.test(value)) {
      errors.push(`${manifestRelativePath}.quoteAssets.${key}: expected EVM address`);
    }
  }

  return { addresses, displayPath: manifestRelativePath };
}

function webDefaultQuoteAssets(environment, errors) {
  const exportName = webDefaultManifestByEnvironment.get(environment);
  if (!exportName) {
    errors.push(`${environment}: missing web default manifest mapping for quote-asset validation`);
    return null;
  }

  const sourcePath = join(repoRoot, webDefaultManifestsPath);
  let source;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch (error) {
    errors.push(`${webDefaultManifestsPath}: unable to read web default manifests: ${error.message}`);
    return null;
  }

  const manifestSource = extractObjectLiteral(source, `export const ${exportName}`);
  if (manifestSource === null) {
    errors.push(`${webDefaultManifestsPath}.${exportName}: unable to locate exported manifest`);
    return null;
  }

  const quoteAssetsSource = extractObjectLiteral(manifestSource, "quoteAssets:");
  if (quoteAssetsSource === null) {
    errors.push(`${webDefaultManifestsPath}.${exportName}.quoteAssets: unable to locate quoteAssets`);
    return null;
  }

  const addresses = new Set();
  for (const match of quoteAssetsSource.matchAll(/^\s*([a-zA-Z0-9_]+):\s*"([^"]+)"\s*,?$/gm)) {
    const [, key, value] = match;
    if (addressPattern.test(value) && value.toLowerCase() !== zeroAddress) {
      addresses.add(value.toLowerCase());
    } else if (!addressPattern.test(value)) {
      errors.push(`${webDefaultManifestsPath}.${exportName}.quoteAssets.${key}: expected EVM address`);
    }
  }

  return { addresses, displayPath: webDefaultManifestsPath, exportName };
}

function extractObjectLiteral(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const start = source.indexOf("{", markerIndex);
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return null;
}

function expectTags(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: expected tag array`);
    return;
  }

  const seen = new Set();
  for (const tag of value) {
    if (typeof tag !== "string" || !allowedTags.has(tag)) {
      errors.push(`${path}: unsupported tag ${format(tag)}`);
    } else if (seen.has(tag)) {
      errors.push(`${path}: duplicate tag ${tag}`);
    }

    seen.add(tag);
  }
}

function format(value) {
  return JSON.stringify(value);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSymbol(value) {
  return typeof value === "string" ? value.toUpperCase() : "";
}

main();
