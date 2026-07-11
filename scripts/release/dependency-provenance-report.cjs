#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const fullMode = args.includes("--full");
const workspacePackages = ["package.json", "packages/sdk/package.json", "apps/web/package.json", "indexer/subgraph/package.json"];
const solidityRoots = ["contracts/joe-v2/src", "contracts/joe-v2/script"];
const riskyLicenses = new Set([
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-3.0",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "BUSL-1.1"
]);
const acceptedSolidityLicenseExceptions = new Set([
  "contracts/joe-v2/src/interfaces/IJoeFactory.sol",
  "contracts/joe-v2/src/interfaces/IJoePair.sol",
  "contracts/joe-v2/src/interfaces/IJoeRouter01.sol",
  "contracts/joe-v2/src/interfaces/IJoeRouter02.sol",
  "contracts/joe-v2/src/libraries/JoeLibrary.sol"
]);
const acceptedNodeLicenseExceptions = [
  {
    pattern: /^web3-(eth-abi|errors|types|utils|validator)$/,
    license: "LGPL-3.0",
    reason: "Transitive Graph CLI dependency used by indexer tooling; not bundled into contracts or the public web app."
  },
  {
    pattern: /^@graphprotocol\/graph-ts$/,
    license: "MISSING",
    reason: "Graph AssemblyScript mappings dependency; provenance is tracked with Graph package pinning until upstream package metadata includes license."
  },
  {
    pattern: /^@rescript\/std$/,
    license: "SEE LICENSE IN LICENSE",
    reason: "Transitive Graph tooling dependency; bundled LICENSE is LGPL-3.0 with additional linking permission and is not bundled into contracts or the public web app."
  }
];
const acceptedPlatformRestrictedPackagePatterns = [
  /^@esbuild\//,
  /^@rolldown\/binding-/,
  /^@rollup\/rollup-/,
  /^@typescript\/typescript-/,
  /^lightningcss-/,
  /^fsevents$/
];
const knownNodeLicensePatterns = [
  /^\(Apache-2\.0 OR MIT\)$/,
  /^\(MIT OR CC0-1\.0\)$/,
  /^0BSD$/,
  /^Apache-2\.0$/,
  /^Apache-2\.0 OR MIT$/,
  /^BlueOak-1\.0\.0$/,
  /^BSD-2-Clause$/,
  /^BSD-3-Clause$/,
  /^ISC$/,
  /^MIT$/,
  /^MPL-2\.0$/,
  /^OFL-1\.1$/,
  /^Python-2\.0$/
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function sha256File(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) return null;

  return crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nodeInventoryRows(entries) {
  return entries.map((entry) => [entry.name, entry.version, entry.license]);
}

function nodeInventoryDigest(entries) {
  return sha256Text(JSON.stringify(nodeInventoryRows(entries)));
}

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, predicate, out);
    } else if (predicate(fullPath)) {
      out.push(fullPath);
    }
  }

  return out;
}

function collectPackages() {
  return workspacePackages.map((relativePath) => {
    const pkg = readJson(relativePath);
    const dependencies = Object.keys(pkg.dependencies ?? {});
    const devDependencies = Object.keys(pkg.devDependencies ?? {});

    return {
      path: relativePath,
      name: pkg.name,
      version: pkg.version ?? null,
      private: pkg.private === true,
      license: pkg.license ?? null,
      dependencies,
      devDependencies
    };
  });
}

function collectSubmodules() {
  try {
    return execFileSync("git", ["submodule", "status"], { cwd: root, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(normalizeSubmoduleStatusLine);
  } catch (error) {
    return [`ERROR: ${error instanceof Error ? error.message : "git submodule status failed"}`];
  }
}

function normalizeSubmoduleStatusLine(line) {
  const match = line.trim().match(/^([+-U]?)([0-9a-f]{40})\s+([^\s]+)/);
  if (!match) return line.trim();

  return `${match[1]}${match[2]} ${match[3]}`;
}

function collectNestedOpenZeppelinSubmodules() {
  const parentPaths = [
    "contracts/joe-v2/lib/openzeppelin-contracts",
    "contracts/joe-v2/lib/openzeppelin-contracts-upgradeable"
  ];
  const entries = [];

  for (const parentPath of parentPaths) {
    const gitmodulesPath = path.join(root, parentPath, ".gitmodules");
    if (!fs.existsSync(gitmodulesPath)) continue;

    const source = fs.readFileSync(gitmodulesPath, "utf8");
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*path\s*=\s*(.+)\s*$/);
      if (match) {
        entries.push(path.posix.join(parentPath, match[1].trim()));
      }
    }
  }

  return entries.sort((left, right) => left.localeCompare(right));
}

function collectLockfilePackages() {
  const lockfilePath = path.join(root, "pnpm-lock.yaml");
  if (!fs.existsSync(lockfilePath)) return [];

  const entries = [];
  const lines = fs.readFileSync(lockfilePath, "utf8").split(/\r?\n/);
  let inPackages = false;
  let current = null;

  function finishCurrent() {
    if (current) {
      entries.push({
        name: current.name,
        version: current.version,
        platformRestricted: current.platformRestricted === true
      });
    }
    current = null;
  }

  for (const line of lines) {
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (line === "snapshots:") {
      finishCurrent();
      break;
    }
    if (!inPackages) continue;

    const packageMatch = line.match(/^  (.+):$/);
    if (packageMatch) {
      finishCurrent();
      current = parsePnpmPackageKey(packageMatch[1]);
      continue;
    }

    if (current && /^    (cpu|libc|os):/.test(line)) {
      current.platformRestricted = true;
    }
  }

  finishCurrent();

  return entries.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function collectPlatformRestrictedPackages(lockfilePackages) {
  return lockfilePackages
    .filter((entry) => entry.platformRestricted)
    .map((entry) => ({ name: entry.name, version: entry.version }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function parsePnpmPackageKey(rawKey) {
  let key = rawKey.trim();
  if ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"'))) {
    key = key.slice(1, -1);
  }

  const peerSuffixStart = key.indexOf("(");
  if (peerSuffixStart !== -1) {
    key = key.slice(0, peerSuffixStart);
  }

  const versionSeparator = key.lastIndexOf("@");
  if (versionSeparator <= 0) return null;

  return {
    name: key.slice(0, versionSeparator),
    version: key.slice(versionSeparator + 1),
    platformRestricted: false
  };
}

function isAcceptedPlatformRestrictedPackage(entry) {
  return acceptedPlatformRestrictedPackagePatterns.some((pattern) => pattern.test(entry.name));
}

function collectNodeDependencyLicenses(options = {}) {
  const includedPackages = options.includedPackages ?? null;
  const excludedPackages = options.excludedPackages ?? new Set();
  const pnpmStore = path.join(root, "node_modules/.pnpm");
  const entries = new Map();

  if (!fs.existsSync(pnpmStore)) {
    return { available: false, entries: [], risky: [], missing: [] };
  }

  for (const storeEntry of fs.readdirSync(pnpmStore)) {
    const nestedNodeModules = path.join(pnpmStore, storeEntry, "node_modules");
    if (!fs.existsSync(nestedNodeModules)) continue;

    for (const packageEntry of fs.readdirSync(nestedNodeModules)) {
      if (packageEntry.startsWith(".")) continue;

      if (packageEntry.startsWith("@")) {
        const scopeDir = path.join(nestedNodeModules, packageEntry);
        if (!fs.statSync(scopeDir).isDirectory()) continue;
        for (const scopedPackage of fs.readdirSync(scopeDir)) {
          collectNodePackage(path.join(scopeDir, scopedPackage, "package.json"), entries, includedPackages, excludedPackages);
        }
      } else {
        collectNodePackage(path.join(nestedNodeModules, packageEntry, "package.json"), entries, includedPackages, excludedPackages);
      }
    }
  }

  const sortedEntries = [...entries.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));

  return {
    available: true,
    entries: sortedEntries,
    risky: sortedEntries.filter((entry) => isRiskyNodeLicense(entry) && !acceptedNodeException(entry)),
    missing: sortedEntries.filter((entry) => entry.license === "MISSING" && !acceptedNodeException(entry)),
    unknown: sortedEntries.filter((entry) => isUnknownNodeLicense(entry) && !acceptedNodeException(entry))
  };
}

function collectNodePackage(packageJsonPath, entries, includedPackages, excludedPackages) {
  if (!fs.existsSync(packageJsonPath)) return;

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (!pkg.name) return;

  const license = normalizeLicense(pkg.license ?? normalizeLicensesArray(pkg.licenses));
  const version = String(pkg.version ?? "unknown");
  const key = `${pkg.name}@${version}`;
  if (includedPackages && !includedPackages.has(key)) return;
  if (excludedPackages.has(key)) return;

  if (!entries.has(key)) {
    entries.set(key, {
      name: pkg.name,
      version,
      license: license ?? "MISSING"
    });
  }
}

function normalizeLicensesArray(value) {
  if (!Array.isArray(value)) return null;

  return value
    .map((entry) => (typeof entry === "string" ? entry : entry?.type))
    .filter(Boolean)
    .join(" OR ");
}

function normalizeLicense(value) {
  if (value && typeof value === "object" && typeof value.type === "string") {
    return value.type.trim();
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

function isRiskyNodeLicense(entry) {
  return entry.license === "MISSING" || [...riskyLicenses].some((license) => entry.license.includes(license));
}

function isUnknownNodeLicense(entry) {
  if (isRiskyNodeLicense(entry)) return false;
  return !knownNodeLicensePatterns.some((pattern) => pattern.test(entry.license));
}

function acceptedNodeException(entry) {
  return acceptedNodeLicenseExceptions.some((exception) => exception.pattern.test(entry.name) && entry.license.includes(exception.license));
}

function collectSpdx() {
  const files = solidityRoots.flatMap((relativeRoot) => walk(path.join(root, relativeRoot), (file) => file.endsWith(".sol")));
  const entries = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const match = source.match(/SPDX-License-Identifier:\s*([^\s]+)/);
    const license = match?.[1] ?? "MISSING";
    const relativePath = path.relative(root, file);

    entries.push({
      path: relativePath,
      license,
      risky: license === "MISSING" || riskyLicenses.has(license)
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function summarizeSpdx(entries) {
  const counts = new Map();

  for (const entry of entries) {
    counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1);
  }

  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function summarizeLicenses(entries) {
  const counts = new Map();

  for (const entry of entries) {
    counts.set(entry.license, (counts.get(entry.license) ?? 0) + 1);
  }

  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function getArgValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;

  return args[index + 1] ?? null;
}

function collectReport(options = {}) {
  const includeFullInventory = options.includeFullInventory === true;
  const rootPackage = readJson("package.json");
  const packages = collectPackages();
  const spdx = collectSpdx();
  const riskySpdx = spdx.filter((entry) => entry.risky);
  const unacceptedRiskySpdx = riskySpdx.filter((entry) => !acceptedSolidityLicenseExceptions.has(entry.path));
  const submodules = collectSubmodules();
  const uninitializedSubmodules = submodules.filter((line) => line.startsWith("-"));
  const nestedOpenZeppelinSubmodules = collectNestedOpenZeppelinSubmodules();
  const lockfilePackages = collectLockfilePackages();
  const lockfilePackageKeys = new Set(lockfilePackages.map((entry) => `${entry.name}@${entry.version}`));
  const platformRestrictedPackages = collectPlatformRestrictedPackages(lockfilePackages);
  const platformRestrictedPackageKeys = new Set(
    platformRestrictedPackages.map((entry) => `${entry.name}@${entry.version}`)
  );
  const unacceptedPlatformRestrictedPackages = platformRestrictedPackages.filter(
    (entry) => !isAcceptedPlatformRestrictedPackage(entry)
  );
  const nodeDependencies = collectNodeDependencyLicenses({
    includedPackages: lockfilePackageKeys,
    excludedPackages: platformRestrictedPackageKeys
  });
  const acceptedNodeExceptions = nodeDependencies.entries.filter(acceptedNodeException);
  const nodeDependencySummary = {
    available: nodeDependencies.available,
    lockfileTotal: lockfilePackages.length,
    total: nodeDependencies.entries.length,
    licenseSummary: summarizeLicenses(nodeDependencies.entries),
    risky: nodeDependencies.risky,
    missing: nodeDependencies.missing,
    unknown: nodeDependencies.unknown,
    inventorySha256: nodeDependencies.available ? nodeInventoryDigest(nodeDependencies.entries) : null,
    platformRestrictedExcluded: platformRestrictedPackages,
    unacceptedPlatformRestricted: unacceptedPlatformRestrictedPackages
  };

  if (includeFullInventory) {
    nodeDependencySummary.entries = nodeDependencies.entries;
  }

  return {
    packageManager: rootPackage.packageManager ?? null,
    lockfilePresent: fs.existsSync(path.join(root, "pnpm-lock.yaml")),
    lockfileSha256: sha256File("pnpm-lock.yaml"),
    packages,
    submodules,
    uninitializedSubmodules,
    nestedOpenZeppelinSubmodules,
    nodeDependencies: nodeDependencySummary,
    spdxSummary: summarizeSpdx(spdx),
    soliditySpdx: includeFullInventory ? spdx : undefined,
    riskySpdx,
    unacceptedRiskySpdx,
    acceptedLicenseExceptions: {
      solidity: riskySpdx.filter((entry) => acceptedSolidityLicenseExceptions.has(entry.path)),
      node: acceptedNodeExceptions
    },
    provenanceDocPresent: fs.existsSync(path.join(root, "docs/provenance/joe-v2.md")),
    legacyDecisionPresent: fs.existsSync(path.join(root, "docs/wave-2/legacy-routing-decision.md"))
  };
}

function toMarkdown(report, options = {}) {
  const includeFullInventory = options.includeFullInventory === true;
  const lines = [
    "# Dependency, License, And Provenance Report",
    "",
    `Package manager: \`${report.packageManager ?? "missing"}\``,
    `Lockfile present: \`${report.lockfilePresent ? "yes" : "no"}\``,
    `Lockfile sha256: \`${report.lockfileSha256 ?? "missing"}\``,
    `Joe V2 provenance doc present: \`${report.provenanceDocPresent ? "yes" : "no"}\``,
    `Legacy routing decision present: \`${report.legacyDecisionPresent ? "yes" : "no"}\``,
    "",
    "## Workspace Packages",
    "",
    "| Package | Path | License | Prod deps | Dev deps |",
    "| --- | --- | --- | ---: | ---: |"
  ];

  for (const pkg of report.packages) {
    lines.push(`| ${pkg.name} | \`${pkg.path}\` | ${pkg.license ?? (pkg.private ? "private/unpublished" : "missing")} | ${pkg.dependencies.length} | ${pkg.devDependencies.length} |`);
  }

  lines.push("", "## Submodules", "");
  for (const line of report.submodules) {
    lines.push(`- \`${line}\``);
  }

  if (report.nestedOpenZeppelinSubmodules.length > 0) {
    lines.push("", "## Direct Nested OpenZeppelin Submodule Declarations", "");
    lines.push("These direct nested submodules are declared by the imported OpenZeppelin parent packages. The committed report lists declarations instead of recursive checkout status so local and CI evidence stay stable across checkout-depth choices.");
    lines.push("");
    for (const line of report.nestedOpenZeppelinSubmodules) {
      lines.push(`- \`${line}\``);
    }
  }

  lines.push("", "## Solidity SPDX Summary", "");
  lines.push("| License | Files |");
  lines.push("| --- | ---: |");
  for (const [license, count] of report.spdxSummary) {
    lines.push(`| ${license} | ${count} |`);
  }

  if (includeFullInventory) {
    lines.push("", "## Full Solidity SPDX Inventory", "");
    lines.push("| File | SPDX license |");
    lines.push("| --- | --- |");
    for (const entry of report.soliditySpdx ?? []) {
      lines.push(`| \`${entry.path}\` | ${entry.license} |`);
    }
  }

  lines.push("", "## Risk/Exception Candidates", "");
  if (report.unacceptedRiskySpdx.length === 0) {
    lines.push("- No unaccepted risky Solidity SPDX entries detected in scanned sources.");
  } else {
    for (const entry of report.unacceptedRiskySpdx) {
      lines.push(`- \`${entry.path}\`: ${entry.license}`);
    }
  }

  lines.push("", "## Accepted License Exceptions", "");
  for (const entry of report.acceptedLicenseExceptions.solidity) {
    lines.push(`- \`${entry.path}\`: ${entry.license} under [legacy-routing-decision.md](../wave-2/legacy-routing-decision.md).`);
  }
  for (const entry of report.acceptedLicenseExceptions.node) {
    const exception = acceptedNodeLicenseExceptions.find((candidate) => candidate.pattern.test(entry.name));
    lines.push(`- \`${entry.name}@${entry.version}\`: ${entry.license}; ${exception?.reason ?? "accepted exception"}`);
  }

  lines.push("", "## Node Dependency License Inventory", "");
  if (!report.nodeDependencies.available) {
    lines.push("- `node_modules/.pnpm` is not present; run `pnpm install --frozen-lockfile` before collecting release evidence.");
  } else {
    lines.push(`- Lockfile packages indexed: ${report.nodeDependencies.lockfileTotal}`);
    lines.push(`- Resolved cross-platform packages scanned: ${report.nodeDependencies.total}`);
    lines.push(`- Unaccepted risky, missing, or unknown licenses: ${report.nodeDependencies.risky.length + report.nodeDependencies.missing.length + report.nodeDependencies.unknown.length}`);
    lines.push(`- Full Node inventory sha256: \`${report.nodeDependencies.inventorySha256 ?? "missing"}\``);
    lines.push(`- Platform-restricted optional packages excluded from portable inventory: ${report.nodeDependencies.platformRestrictedExcluded.length}`);
    lines.push(`- Unaccepted platform-restricted package patterns: ${report.nodeDependencies.unacceptedPlatformRestricted.length}`);
  }

  if (report.nodeDependencies.platformRestrictedExcluded.length > 0) {
    lines.push("", "## Platform-Restricted Optional Packages", "");
    lines.push("These packages are pinned in `pnpm-lock.yaml`, but excluded from the persisted installed-package inventory so macOS and Linux runners produce the same release evidence. New names outside the accepted native build-tool patterns fail the provenance gate.");
    lines.push("");
    lines.push("| Package | Version |");
    lines.push("| --- | --- |");
    for (const entry of report.nodeDependencies.platformRestrictedExcluded) {
      lines.push(`| \`${entry.name}\` | \`${entry.version}\` |`);
    }
  }

  if (includeFullInventory && report.nodeDependencies.available) {
    lines.push("", "## Full Node Dependency Inventory", "");
    lines.push("| Package | Version | License |");
    lines.push("| --- | --- | --- |");
    for (const entry of report.nodeDependencies.entries ?? []) {
      lines.push(`| \`${entry.name}\` | \`${entry.version}\` | ${entry.license} |`);
    }
  }

  if (report.uninitializedSubmodules.length > 0) {
    lines.push("", "## Submodule Warnings", "");
    for (const line of report.uninitializedSubmodules) {
      lines.push(`- Top-level uninitialized: \`${line}\``);
    }
  }
  if (report.nestedOpenZeppelinSubmodules.length > 0) {
    if (report.uninitializedSubmodules.length === 0) {
      lines.push("", "## Submodule Warnings", "");
    }
    lines.push("- Nested OpenZeppelin test submodules are covered by `docs/provenance/license-exceptions.md`; attach raw `git submodule status --recursive` output separately when collecting release evidence.");
  }

  lines.push("", "## Launch Notes", "");
  lines.push("- GPL-tagged legacy routing files are accepted only under the documented legacy-routing decision.");
  lines.push("- Any new GPL, AGPL, BUSL, missing, or unknown license in distributed code is a launch blocker until approved.");
  lines.push("- Any new platform-restricted optional package outside the accepted native build-tool patterns is a launch blocker until reviewed.");
  lines.push("- Attach this report, `git submodule status --recursive`, and the frozen install result to the release ticket.");

  return `${lines.join("\n")}\n`;
}

function outputTarget(mode) {
  const index = args.indexOf(mode);
  if (index === -1) return null;

  const target = getArgValue(mode);
  if (!target || target.startsWith("-")) {
    throw new Error(`${mode} requires a path argument`);
  }

  return path.resolve(root, target);
}

function writeOutput(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, payload);
}

function requireLine(document, line, errors) {
  if (!document.split(/\r?\n/).includes(line)) {
    errors.push(`dependency report missing expected line: ${line}`);
  }
}

function parseFullNodeInventory(document) {
  const lines = document.split(/\r?\n/);
  const start = lines.indexOf("## Full Node Dependency Inventory");
  if (start === -1) return null;

  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;

    const match = line.match(/^\| `(.+)` \| `(.+)` \| (.+) \|$/);
    if (match) rows.push([match[1], match[2], match[3]]);
  }

  return rows;
}

function checkEmbeddedNodeInventoryDigest(current, errors) {
  const digestMatch = current.match(/^- Full Node inventory sha256: `([a-f0-9]{64})`$/m);
  if (!digestMatch) {
    errors.push("dependency report missing embedded Full Node inventory sha256");
    return;
  }

  const rows = parseFullNodeInventory(current);
  if (!rows || rows.length === 0) {
    errors.push("dependency report missing Full Node dependency inventory rows");
    return;
  }

  const actualDigest = sha256Text(JSON.stringify(rows));
  if (actualDigest !== digestMatch[1]) {
    errors.push("dependency report Full Node inventory table does not match embedded sha256");
  }
}

function checkMarkdownOutput(filePath, current, report, errors) {
  const initialErrorCount = errors.length;
  const requiredTokens = [
    "# Dependency, License, And Provenance Report",
    "## Workspace Packages",
    "## Submodules",
    "## Solidity SPDX Summary",
    "## Full Solidity SPDX Inventory",
    "## Risk/Exception Candidates",
    "## Accepted License Exceptions",
    "## Node Dependency License Inventory",
    "## Platform-Restricted Optional Packages",
    "## Full Node Dependency Inventory",
    "## Launch Notes"
  ];

  for (const token of requiredTokens) {
    if (!current.includes(token)) {
      errors.push(`dependency report missing required section: ${token}`);
    }
  }

  requireLine(current, `Package manager: \`${report.packageManager ?? "missing"}\``, errors);
  requireLine(current, `Lockfile present: \`${report.lockfilePresent ? "yes" : "no"}\``, errors);
  requireLine(current, `Lockfile sha256: \`${report.lockfileSha256 ?? "missing"}\``, errors);
  requireLine(current, `Joe V2 provenance doc present: \`${report.provenanceDocPresent ? "yes" : "no"}\``, errors);
  requireLine(current, `Legacy routing decision present: \`${report.legacyDecisionPresent ? "yes" : "no"}\``, errors);

  for (const pkg of report.packages) {
    requireLine(
      current,
      `| ${pkg.name} | \`${pkg.path}\` | ${pkg.license ?? (pkg.private ? "private/unpublished" : "missing")} | ${pkg.dependencies.length} | ${pkg.devDependencies.length} |`,
      errors
    );
  }
  for (const line of report.submodules) {
    requireLine(current, `- \`${line}\``, errors);
  }
  for (const line of report.nestedOpenZeppelinSubmodules) {
    requireLine(current, `- \`${line}\``, errors);
  }
  for (const [license, count] of report.spdxSummary) {
    requireLine(current, `| ${license} | ${count} |`, errors);
  }
  for (const entry of report.soliditySpdx ?? []) {
    requireLine(current, `| \`${entry.path}\` | ${entry.license} |`, errors);
  }
  for (const entry of report.nodeDependencies.platformRestrictedExcluded) {
    requireLine(current, `| \`${entry.name}\` | \`${entry.version}\` |`, errors);
  }
  checkEmbeddedNodeInventoryDigest(current, errors);

  if (errors.length > initialErrorCount) {
    errors.push(`committed dependency report is stale or incomplete: ${path.relative(root, filePath)}; run pnpm release:provenance:report`);
  }
}

function checkOutput(filePath, payload, report, errors) {
  if (!fs.existsSync(filePath)) {
    errors.push(`expected generated report is missing: ${path.relative(root, filePath)}`);
    return;
  }

  const current = fs.readFileSync(filePath, "utf8");
  if (path.extname(filePath).toLowerCase() === ".md") {
    checkMarkdownOutput(filePath, current, report, errors);
    return;
  }

  if (current !== payload) {
    errors.push(`generated report is stale: ${path.relative(root, filePath)}; run pnpm release:provenance:report`);
  }
}

const outputPath = outputTarget("--output");
const checkPath = outputTarget("--check");
const includeFullInventory = fullMode || Boolean(outputPath) || Boolean(checkPath);
const report = collectReport({ includeFullInventory });
const errors = [];
const warnings = [];

if (!report.packageManager) errors.push("package.json missing packageManager");
if (!report.lockfilePresent) errors.push("pnpm-lock.yaml missing");
if (!report.provenanceDocPresent) errors.push("docs/provenance/joe-v2.md missing");
if (!report.legacyDecisionPresent) errors.push("docs/wave-2/legacy-routing-decision.md missing");
if (report.unacceptedRiskySpdx.length > 0) {
  errors.push(`unaccepted risky Solidity SPDX entries: ${report.unacceptedRiskySpdx.map((entry) => entry.path).join(", ")}`);
}
if (report.nodeDependencies.available && report.nodeDependencies.risky.length > 0) {
  errors.push(`unaccepted risky node dependency licenses: ${report.nodeDependencies.risky.map((entry) => `${entry.name}@${entry.version}:${entry.license}`).join(", ")}`);
}
if (report.nodeDependencies.available && report.nodeDependencies.missing.length > 0) {
  errors.push(`unaccepted missing node dependency licenses: ${report.nodeDependencies.missing.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`);
}
if (report.nodeDependencies.available && report.nodeDependencies.unknown.length > 0) {
  errors.push(`unaccepted unknown node dependency licenses: ${report.nodeDependencies.unknown.map((entry) => `${entry.name}@${entry.version}:${entry.license}`).join(", ")}`);
}
if (report.nodeDependencies.unacceptedPlatformRestricted.length > 0) {
  errors.push(
    `unaccepted platform-restricted packages: ${
      report.nodeDependencies.unacceptedPlatformRestricted.map((entry) => `${entry.name}@${entry.version}`).join(", ")
    }`
  );
}
if (!report.nodeDependencies.available) {
  warnings.push("node_modules/.pnpm missing; dependency license inventory was not collected");
}
if (report.uninitializedSubmodules.length > 0) {
  warnings.push(`uninitialized top-level submodules: ${report.uninitializedSubmodules.join("; ")}`);
}
if (report.nestedOpenZeppelinSubmodules.length > 0) {
  warnings.push(
    `nested OpenZeppelin test submodules covered by license-exceptions.md: ${report.nestedOpenZeppelinSubmodules.join("; ")}`
  );
}

function renderJsonPayload() {
  return `${JSON.stringify({ ok: errors.length === 0, errors, warnings, report }, null, 2)}\n`;
}

function renderMarkdownPayload() {
  return toMarkdown(report, { includeFullInventory });
}

function renderFilePayload(filePath) {
  return jsonMode && path.extname(filePath).toLowerCase() === ".json" ? renderJsonPayload() : renderMarkdownPayload();
}

if (outputPath) {
  writeOutput(outputPath, renderFilePayload(outputPath));
}

if (checkPath) {
  checkOutput(checkPath, renderFilePayload(checkPath), report, errors);
}

if (jsonMode) {
  console.log(renderJsonPayload().trimEnd());
} else {
  if (!outputPath && !checkPath) {
    console.log(renderMarkdownPayload());
  } else if (outputPath) {
    console.log(`Wrote dependency/provenance report: ${path.relative(root, outputPath)}`);
  } else {
    console.log(`Checked dependency/provenance report: ${path.relative(root, checkPath)}`);
  }

  if (warnings.length > 0) {
    console.error(`Dependency/provenance warnings:\n- ${warnings.join("\n- ")}`);
  }
  if (errors.length > 0) {
    console.error(`Dependency/provenance validation failed:\n- ${errors.join("\n- ")}`);
  }
}

if (errors.length > 0) {
  process.exitCode = 1;
}
