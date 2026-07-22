#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const zeroAddress = "0x0000000000000000000000000000000000000000";
const paginationEvidencePath = "docs/wave-2/evidence/robinhood-testnet-pagination-rehearsal.json";
const testnetManifestEvidencePath = "docs/wave-2/evidence/robinhood-testnet-manifest.json";
const testnetLaunchPacketPath = "docs/wave-2/evidence/testnet-launch-packet.json";
const jsonMode = process.argv.includes("--json");
const strictLaunch = process.argv.includes("--strict-launch");
const runtimeManifests = process.argv.includes("--runtime-manifests");

const requiredScripts = [
  "contracts:build",
  "contracts:test:core",
  "contracts:test:full",
  "contracts:test:fork",
  "contracts:test:fork:router",
  "contracts:test:fork:quoter",
  "contracts:test:fork:priority",
  "contracts:test:exhaustive",
  "contracts:fmt",
  "tokens:validate",
  "manifests:validate",
  "sdk:typecheck",
  "sdk:test",
  "sdk:build",
  "sdk:e2e:localnet:expected-revert",
  "web:typecheck",
  "web:test:pagination",
  "web:test:pool-selection",
  "web:test:positions",
  "web:test:safety",
  "web:test:e2e",
  "web:test:e2e:localnet",
  "web:build",
  "web:fixture:public",
  "web:test:public-config",
  "web:validate:public-runtime",
  "web:test:public-runtime",
  "web:validate:public-config",
  "web:check:public-artifact",
  "web:check:hosted-release",
  "web:test:hosted-release",
  "web:build:public:testnet",
  "web:build:public:mainnet",
  "vps:validate",
  "vps:test",
  "analytics:custody:build",
  "indexer:generate:robinhood",
  "indexer:build:robinhood:testnet",
  "indexer:build:robinhood:mainnet",
  "indexer:build:rendered",
  "indexer:build",
  "indexer:test:goldsky:robinhood",
  "indexer:test:pair-fees",
  "indexer:test:graph-node-assertions",
  "indexer:e2e:graph-node",
  "indexer:test:smoke:robinhood",
  "e2e:localnet",
  "indexer:deploy:goldsky:robinhood",
  "robinhood:dry-run",
  "robinhood:deploy",
  "robinhood:deploy:test",
  "robinhood:verify",
  "robinhood:verify:test",
  "robinhood:ownership:check",
  "robinhood:ownership:test",
  "robinhood:rpc:check",
  "robinhood:rpc:test",
  "robinhood:remove-liquidity:rehearse",
  "robinhood:remove-liquidity:test",
  "graph-node:validate",
  "release:gates",
  "release:provenance",
  "release:provenance:report",
  "release:provenance:check",
  "release:static-analysis:triage",
  "release:audit:validate",
  "release:audit:strict",
  "release:audit:test",
  "release:audit:bundle",
  "release:launch-records:validate",
  "release:launch-records:test",
  "release:launch-records:strict",
  "release:web-promotion:test",
  "release:runbooks:validate",
  "release:runbooks:test",
  "release:testnet-evidence:check",
  "release:testnet-evidence:test",
  "observability:validate",
  "observability:test",
  "observability:redaction:test",
  "launch:health",
  "launch:health:test"
];

const requiredDocs = [
  "docs/wave-2/release-security-gates.md",
  "docs/wave-2/static-analysis-triage.md",
  "docs/wave-2/dependency-license-provenance-gate.md",
  "docs/wave-2/full-upstream-test-modes.md",
  "docs/wave-2/transaction-preflight.md",
  "docs/wave-2/public-environment-config.md",
  "docs/wave-2/token-list-policy.md",
  "docs/wave-2/graphql-pagination.md",
  "docs/wave-2/wallet-e2e-testing.md",
  "docs/wave-2/liquidity-position-burn-readiness.md",
  "docs/wave-2/liquidity-composition-decision.md",
  "docs/wave-2/audit-readiness-package.md",
  "docs/wave-2/threat-model.md",
  "docs/wave-2/pre-mainnet-launch-gate.md",
  "docs/wave-2/testnet-launch-rehearsal-evidence.md",
  "docs/wave-2/local-production-rehearsal.md",
  "docs/wave-2/admin-ownership-handoff.md",
  "docs/wave-2/observability-incident-response.md",
  "docs/wave-2/legacy-routing-decision.md",
  "docs/wave-2/routing-api-backend-strategy.md",
  "docs/wave-2/robinhood-subgraph-deployment.md",
  "docs/wave-2/rpc-archive-provider-readiness.md",
  "docs/wave-2/robinhood-testnet-rpc-readiness-evidence.md",
  "docs/wave-2/robinhood-testnet-contract-verification-evidence.md",
  "docs/wave-2/self-hosted-graph-node-runbook.md",
  "docs/wave-2/robinhood-goldsky-testnet-evidence.md",
  "docs/wave-2/robinhood-multibin-remove-rehearsal-evidence.md",
  "docs/provenance/joe-v2.md",
  "docs/provenance/dependency-license-report.md",
  "docs/provenance/license-exceptions.md"
];

const requiredFiles = [
  "pnpm-workspace.yaml",
  "infra/vps/Caddyfile",
  "infra/vps/compose.yml",
  "infra/graph-node/.env.example",
  "infra/graph-node/docker-compose.robinhood.example.yml",
  "infra/graph-node/README.md",
  "scripts/contracts/require-fork-rpc.cjs",
  "scripts/indexer/deploy-goldsky-robinhood.sh",
  "scripts/robinhood/check-ownership-handoff.cjs",
  "scripts/robinhood/test-check-ownership-handoff.cjs",
  "scripts/robinhood/check-rpc-readiness.cjs",
  "scripts/robinhood/test-check-rpc-readiness.cjs",
  "scripts/robinhood/rehearse-remove-liquidity.cjs",
  "scripts/robinhood/test-rehearse-remove-liquidity-batching.cjs",
  "scripts/robinhood/test-verify-constructor-args.cjs",
  "scripts/robinhood/redact-command-output.cjs",
  "scripts/robinhood/test-deploy-wrapper.cjs",
  "scripts/release/test-check-launch-health.cjs",
  "scripts/release/validate-vps-deployment.cjs",
  "scripts/release/test-validate-vps-deployment.cjs",
  "scripts/release/build-analytics-runtime-custody.cjs",
  "scripts/release/test-build-analytics-runtime-custody.cjs",
  "scripts/release/check-self-hosted-graph-node.cjs",
  "scripts/release/check-static-analysis-triage.cjs",
  "scripts/release/validate-audit-readiness.cjs",
  "scripts/release/test-validate-audit-readiness.cjs",
  "scripts/release/build-audit-bundle.cjs",
  "scripts/release/validate-launch-records.cjs",
  "scripts/release/test-validate-launch-records.cjs",
  "scripts/release/web-promotion-custody.cjs",
  "scripts/release/write-web-promotion-evidence.cjs",
  "scripts/release/promote-web-provider.sh",
  "scripts/release/test-web-promotion.cjs",
  "scripts/release/validate-operator-runbooks.cjs",
  "scripts/release/test-validate-operator-runbooks.cjs",
  ".github/workflows/web-promotion.yml",
  "docs/wave-2/protected-web-promotion.md",
  "docs/wave-2/runbooks/README.md",
  "docs/wave-2/audit/scope.json",
  "docs/wave-2/audit/findings.json",
  "docs/wave-2/audit/exceptions.json",
  "docs/wave-2/launch/README.md",
  "docs/wave-2/launch/final-go-no-go.template.json",
  "docs/wave-2/launch/rpc-provider-decision.template.json",
  "docs/wave-2/launch/admin-control-decision.template.json",
  "scripts/release/materialize-testnet-evidence.cjs",
  "scripts/release/validate-testnet-launch-packet.cjs",
  "scripts/release/test-validate-testnet-launch-packet.cjs",
  "scripts/release/validate-observability-evidence.cjs",
  "scripts/release/test-validate-observability-evidence.cjs",
  "scripts/web/check-hosted-release.cjs",
  "scripts/web/test-check-hosted-release.cjs",
  "scripts/web/redact-observability-output.cjs",
  "scripts/web/test-redact-observability-output.cjs",
  ".github/workflows/observability-health.yml",
  "infra/monitoring/monitors.json",
  "infra/monitoring/dashboards.json",
  "infra/monitoring/alert-routing.example.json",
  "infra/monitoring/tabletop-evidence.template.json",
  "docs/wave-2/static-analysis-triage.json",
  "scripts/indexer/smoke-robinhood.sh",
  "scripts/indexer/validate-smoke-robinhood.cjs",
  "scripts/indexer/test-validate-smoke-robinhood.cjs",
  "scripts/indexer/test-smoke-robinhood-wrapper.cjs",
  "scripts/indexer/test-deploy-goldsky-robinhood.cjs",
  "indexer/subgraph/tests/pair-composition-fees.test.ts",
  "scripts/indexer/assert-graph-node-mappings.cjs",
  "scripts/indexer/test-assert-graph-node-mappings.cjs",
  "scripts/indexer/run-graph-node-e2e.sh",
  "scripts/e2e/run-localnet-transactions.cjs",
  "scripts/e2e/run-browser-localnet.cjs",
  "packages/sdk/examples/preflight-transaction.ts",
  "packages/sdk/test/preflight-transaction.test.ts",
  "packages/sdk/test/localnet-expected-revert-fixture.ts",
  "packages/sdk/src/routing-policy.ts",
  "apps/web/playwright.config.ts",
  "apps/web/playwright.localnet.config.ts",
  "apps/web/e2e/wallet-states.spec.ts",
  "apps/web/e2e/fixtures/mock-wallet.ts",
  "apps/web/e2e/localnet/browser-localnet.spec.ts",
  "apps/web/e2e/localnet/fixtures/unlocked-rpc-wallet.ts",
  "scripts/web/create-public-config-fixture.cjs",
  "scripts/web/test-public-config.cjs",
  "scripts/web/validate-public-runtime.cjs",
  "scripts/web/test-public-runtime.cjs",
  "scripts/web/check-public-artifact.cjs",
  "contracts/joe-v2/script/rehearse-robinhood-multibin-remove.s.sol",
  "contracts/joe-v2/script/rehearse-robinhood-pagination.s.sol",
  paginationEvidencePath,
  testnetManifestEvidencePath,
  testnetLaunchPacketPath
];

const removedZapFiles = [
  "contracts/joe-v2/src/zap/LBZap.sol",
  "contracts/joe-v2/test/LBZap.t.sol",
  "contracts/joe-v2/test/RobinhoodDeployScript.t.sol",
  "packages/sdk/src/zap.ts",
  "packages/sdk/examples/localnet-zap-in.ts",
  "packages/sdk/examples/localnet-zap-out.ts",
  "indexer/subgraph/abis/LBZap.json",
  "indexer/subgraph/src/zap.ts"
];

const retiredCloudflareControlFiles = [
  "apps/web/public/_headers",
  "apps/web/public/_redirects",
  "apps/web/public/_worker.js"
];

const gates = [
  ["contracts-build", "#53", "PR-blocking", "contracts", "pnpm contracts:build"],
  ["contracts-core-tests", "#53/#16", "PR-blocking", "contracts", "pnpm contracts:test:core"],
  ["contracts-format", "#53/#16", "launch-blocking", "contracts", "pnpm contracts:fmt"],
  ["contracts-full-tests", "#53/#16", "manual launch-blocking", "contracts", "pnpm contracts:test:full"],
  ["fork-router", "#16", "manual/provider-gated", "contracts", "pnpm contracts:test:fork:router"],
  ["fork-quoter", "#16", "manual/provider-gated", "contracts", "pnpm contracts:test:fork:quoter"],
  ["fork-priority", "#16", "manual/provider-gated slow path", "contracts", "pnpm contracts:test:fork:priority"],
  ["contracts-exhaustive-tests", "#16/#53", "manual/provider-gated launch-blocking", "contracts", "pnpm contracts:test:exhaustive"],
  ["slither", "#53", "advisory in CI, launch-blocking after triage", "security", "slither . --config-file slither.config.json"],
  ["static-analysis-triage", "#53", "PR-blocking register, launch-blocking findings", "security", "pnpm release:static-analysis:triage -- --json"],
  ["token-lists", "#49/#53", "PR-blocking", "frontend", "pnpm tokens:validate"],
  ["manifests", "#43/#53/#110", "PR-blocking", "deploy", "pnpm manifests:validate"],
  ["runtime-manifests", "#53/#55", "manual launch-blocking", "deploy", "pnpm release:gates -- --runtime-manifests"],
  ["sdk", "#53/#95/#97/#100/#106/#110", "PR-blocking", "sdk", "pnpm sdk:typecheck && pnpm sdk:test && pnpm sdk:build"],
  ["web", "#28/#29/#43/#46/#51/#53/#95/#97/#99/#100/#102/#106/#108/#110", "PR-blocking", "web", "pnpm web:typecheck && pnpm web:test:pagination && pnpm web:test:pool-selection && pnpm web:test:positions && pnpm web:test:safety && pnpm web:test:e2e && pnpm web:build"],
  ["browser-localnet-e2e", "#28/#51/#102/#107", "PR-blocking", "e2e", "pnpm web:test:e2e:localnet"],
  ["localnet-e2e", "#28/#51", "PR-blocking", "e2e", "pnpm e2e:localnet"],
  ["indexer", "#29/#42/#53/#101", "PR-blocking", "indexer", "pnpm indexer:build && pnpm indexer:test:smoke:robinhood"],
  ["indexer-pair-fees", "#42/#111", "PR-blocking", "indexer", "pnpm indexer:test:pair-fees"],
  ["goldsky-wrapper-tests", "#36/#109", "PR-blocking", "indexer", "pnpm indexer:test:goldsky:robinhood"],
  ["graph-node-assertion-fixtures", "#37/#42/#103", "PR-blocking", "indexer", "pnpm indexer:test:graph-node-assertions"],
  ["graph-node-mapping-e2e", "#37/#42/#53/#103", "PR-blocking", "indexer", "pnpm indexer:e2e:graph-node"],
  ["backend-strategy", "#19", "launch decision", "backend", "docs/wave-2/routing-api-backend-strategy.md"],
  ["robinhood-subgraph-render", "#36/#53/#60", "PR-blocking examples, launch-blocking live manifest", "indexer", "pnpm indexer:build:robinhood:testnet && pnpm indexer:build:robinhood:mainnet"],
  ["goldsky-deploy", "#36/#42/#55", "manual/credential-gated", "indexer", "ROBINHOOD_MANIFEST_PATH=... pnpm indexer:deploy:goldsky:robinhood"],
  ["self-hosted-graph-node", "#37/#47/#61", "PR-blocking fallback shape, launch-blocking if selected", "indexer", "pnpm graph-node:validate"],
  ["public-web-testnet", "#43/#46/#53/#99/#110", "manual launch-blocking", "web", "VITE_ROBINHOOD_TESTNET_MANIFEST_PATH=... pnpm web:build:public:testnet && pnpm web:check:public-artifact -- --environment robinhoodTestnet --manifest ... --dist apps/web/dist"],
  ["public-web-mainnet", "#43/#46/#53/#99/#110", "manual launch-blocking", "web", "VITE_ROBINHOOD_MANIFEST_PATH=... pnpm web:build:public:mainnet && pnpm web:check:public-artifact -- --environment robinhood --manifest ... --dist apps/web/dist"],
  ["vps-hosting", "#43/#55/#61", "PR-blocking deployment shape, manual production rollout", "web", "pnpm vps:validate && pnpm vps:test"],
  ["protected-web-promotion", "#43/#55/#61", "PR-blocking workflow shape, manual provider deployment", "web", "pnpm release:web-promotion:test"],
  ["hosted-web-smoke", "#43/#55/#61", "PR-blocking helper, manual launch evidence", "web", "pnpm web:test:hosted-release && pnpm web:check:hosted-release -- <https-url>"],
  [
    "dependency-provenance",
    "#60/#15",
    "PR-blocking inventory, launch-blocking triage",
    "security",
    "pnpm release:provenance -- --json && pnpm release:provenance:check"
  ],
  ["audit-readiness", "#41", "manual launch-blocking", "security", "Review docs/wave-2/audit-readiness-package.md and docs/wave-2/threat-model.md"],
  ["audit-handoff-integrity", "#41/#53", "PR-blocking records", "security", "pnpm release:audit:validate && pnpm release:audit:test"],
  ["external-audit-approval", "#41/#53", "manual launch-blocking", "security", "pnpm release:audit:strict"],
  ["audit-bundle", "#41/#53", "manual launch evidence", "security", "pnpm release:audit:bundle --output .local/audit/release-candidate"],
  ["launch-decision-records", "#41/#43/#47/#52/#53/#55/#61", "PR-blocking templates", "release", "pnpm release:launch-records:validate && pnpm release:launch-records:test"],
  ["launch-decision-records-strict", "#41/#43/#47/#52/#53/#55/#61", "manual launch-blocking", "release", "RELEASE_COMMIT=... FINAL_GO_NO_GO_RECORD=... RPC_PROVIDER_RECORD=... ADMIN_CONTROL_RECORD=... pnpm release:launch-records:strict"],
  ["liquidity-composition", "#9/#10/#48/#94/#96/#104/#105/#113", "PR-blocking scope decision", "liquidity", "docs/wave-2/liquidity-composition-decision.md"],
  [
    "remove-liquidity-rehearsal",
    "#29",
    "manual launch-blocking",
    "liquidity",
    "pnpm robinhood:remove-liquidity:rehearse -- --manifest <latest.json> --owner <wallet> --pair <pair> --min-bins 7 --max-indexer-lag 300 --json"
  ],
  ["deployment-dry-run", "#53/#55", "manual launch-blocking", "deploy", "ROBINHOOD_ENV=<env> pnpm robinhood:dry-run"],
  ["deployment-wrapper-tests", "#53/#98", "PR-blocking", "deploy", "pnpm robinhood:deploy:test"],
  ["contract-verification-helper", "#53", "PR-blocking", "deploy", "pnpm robinhood:verify:test"],
  ["contract-verification", "#53/#55", "manual launch-blocking", "deploy", "ROBINHOOD_ENV=<env> pnpm robinhood:verify"],
  [
    "rpc-replay-readiness",
    "#47",
    "manual launch-blocking",
    "ops",
    "pnpm --silent robinhood:rpc:check -- <latest.json> --strict-launch --rpc-url \"$ROBINHOOD_RPC_URL\" --fallback-rpc-url \"$ROBINHOOD_FALLBACK_RPC_URL\" --factory-deployment-block \"$ROBINHOOD_RPC_CHECK_FACTORY_BLOCK\" --pair \"$ROBINHOOD_RPC_CHECK_PAIR\" --pair-historical-block \"$ROBINHOOD_RPC_CHECK_PAIR_BLOCK\" [--archive-rpc-url \"$ROBINHOOD_ARCHIVE_RPC_URL\"] --json"
  ],
  ["ownership-helper-tests", "#52", "PR-blocking", "ops", "pnpm robinhood:ownership:test"],
  ["ownership-handoff", "#52", "manual launch-blocking", "ops", "pnpm --silent robinhood:ownership:check -- <latest.json> --strict-launch --rpc-url \"$ROBINHOOD_OWNERSHIP_RPC_URL\" --expected-owner \"$ROBINHOOD_PRODUCTION_OWNER\" --expected-fee-recipient \"$ROBINHOOD_FEE_RECIPIENT\" --json"],
  [
    "launch-health",
    "#61/#47",
    "manual launch-blocking",
    "ops",
    "pnpm launch:health -- <latest.json> --strict-launch --rpc-url \"$ROBINHOOD_RPC_URL\" --graphql-url \"$ROBINHOOD_SUBGRAPH_URL\" --expected-owner \"$ROBINHOOD_PRODUCTION_OWNER\" --expected-fee-recipient \"$ROBINHOOD_FEE_RECIPIENT\" --json"
  ],
  ["launch-health-helper-tests", "#61", "PR-blocking", "ops", "pnpm launch:health:test"],
  ["observability", "#61", "manual launch-blocking", "ops", "docs/wave-2/observability-incident-response.md"],
  ["observability-definitions", "#61", "PR-blocking", "ops", "pnpm observability:validate && pnpm observability:test && pnpm observability:redaction:test"],
  ["operator-runbooks", "#47/#52/#53/#61", "PR-blocking", "ops", "pnpm release:runbooks:validate && pnpm release:runbooks:test"],
  ["testnet-evidence-packet", "#55", "PR-blocking", "release", "pnpm release:testnet-evidence:check && pnpm release:testnet-evidence:test"],
  ["testnet-rehearsal", "#55", "manual launch-blocking", "release", "docs/wave-2/testnet-launch-rehearsal-evidence.md"],
  ["review-remediation-tracker", "#112", "release reconciliation", "release", "GitHub issue #112 checklist and evidence comments"]
];

const requiredReviewIssueIds = Array.from({ length: 20 }, (_, index) => `#${94 + index}`);
const reviewIssueCoverage = Object.fromEntries(
  requiredReviewIssueIds.map((issueId) => [
    issueId,
    gates.filter(([, issueRefs]) => issueRefs.split("/").includes(issueId)).map(([gateId]) => gateId)
  ])
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function sha256(relativePath) {
  return crypto.createHash("sha256").update(readText(relativePath)).digest("hex");
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function includesAll(haystack, tokens) {
  const source = lower(haystack);
  return tokens.every((token) => source.includes(lower(token)));
}

function findCheck(checks, name) {
  return Array.isArray(checks) ? checks.find((check) => check?.name === name) : undefined;
}

function isAddress(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
}

function validatePaginationEvidence(evidence) {
  const evidenceErrors = [];
  const expect = (condition, message) => {
    if (!condition) evidenceErrors.push(message);
  };
  const equalAddress = (actual, expected) => isAddress(actual) && lower(actual) === lower(expected);
  const expectedTransactions = [
    ["mint-test-token", "0xf13fafeae001d6478c25fdd5c82f2a8bd412853cd5037d2f1bca3cec038a8a39", 89302430],
    ["wrap-native", "0x511a2e2ebbf4a30c2b3dc31fb064c701b18e98159f5aec4cd7168f178689528d", 89302437],
    ["clear-token-allowance", "0x9b57f5531bf5981d6b8db80b9d17960d3cd0ac474fc23cf7862b6b9fd3b4e4c1", 89302446],
    ["set-token-allowance", "0x4e4d0bfc8cd29a35ac53d35c28c9c2cdac31cbeb28e00f47a25ffa1f6fedcd8e", 89302454],
    ["clear-weth-allowance", "0x0d6ad15302b7328123837511469f51db62223881683f20bd193c9362a1eb65eb", 89302463],
    ["set-weth-allowance", "0x8d397697281d1eb33c734819ca9ea5aed9aef64ebe3e8ce2b6f78265672c4ba5", 89302472],
    ["add-101-bin-liquidity", "0xfc0c51599021fdbca1fbd59d2f4c72f817bbf36194e9e5d5ed32f57e2bd3ca80", 89302484],
    ["revoke-token-allowance", "0xcb0585fc8643772582b578f51f350845656281b8861236a0973ec24fc01f79a4", 89302493],
    ["revoke-weth-allowance", "0xd3671bd194e754979126095f83e1382df421380e6c86656b7cc0b7aef10415bc", 89302500]
  ];
  const expectedWebCases = [
    "stale indexer state blocks remove before simulation or wallet submission",
    "partial owner position page failure blocks remove before simulation or wallet submission",
    "live and indexed LB balance mismatch blocks remove before simulation or wallet submission",
    "fresh same-click LB balance guard blocks remove before simulation or wallet submission",
    "same-click remove preflight rejects a stale indexer transition after click",
    "same-click remove preflight rejects a indexer error transition after click",
    "same-click remove preflight rejects a partial owner position pagination transition after click",
    "same-click LB approval preflight rejects cached summary data after a refetch error on desktop and mobile",
    "same-click LB approval preflight rejects indexer metadata errors on desktop and mobile",
    "same-click LB approval preflight rejects partial owner position pagination on desktop and mobile",
    "LB approval rechecks indexer freshness after simulation before wallet submission",
    "LB approval is cancelled when the wallet chain changes during simulation on desktop and mobile",
    "capped owner position pagination fails closed"
  ];
  const result = evidence?.rehearsal?.result;
  const checks = result?.checks;
  const checkMatches = (name, fields = {}) => {
    const check = findCheck(checks, name);
    return check?.status === "pass" && Object.entries(fields).every(([key, value]) => check[key] === value);
  };

  expect(evidence?.schemaVersion === "robinhood.testnet.pagination-rehearsal.v1", "unsupported schemaVersion");
  expect(evidence?.manifest?.path === "deployments/robinhood/testnet/latest.json", "unexpected manifest path");
  expect(evidence?.manifest?.sha256 === "d19848d61100542f3c45350ee879334c3d7ea15e31bffbc05d421d431f2de6b2", "unexpected manifest SHA-256");
  expect(evidence?.chainId === 46630, "expected chainId 46630");
  expect(equalAddress(evidence?.owner, "0x51135ecbebe411eb31f13241e862369627b020ef"), "unexpected owner");
  expect(equalAddress(evidence?.pair, "0xceb55017330fe79c53b3c0ba0d454bf275b84161"), "unexpected pair");
  expect(equalAddress(evidence?.router, "0x502e6516887547130a0e7cfd3f9849c57651d479"), "unexpected router");
  expect(equalAddress(evidence?.tokens?.token, "0xfa35a01a83e43c33c487080b1667900d091ea371"), "unexpected test token");
  expect(equalAddress(evidence?.tokens?.weth, "0x7943e237c7f95da44e0301572d358911207852fa"), "unexpected WETH");
  expect(Array.isArray(evidence?.transactions) && evidence.transactions.length === expectedTransactions.length, "expected nine transactions");
  for (const [index, [action, hash, blockNumber]] of expectedTransactions.entries()) {
    const transaction = evidence?.transactions?.[index];
    expect(transaction?.action === action && lower(transaction?.hash) === hash && transaction?.status === 1 && transaction?.blockNumber === blockNumber, `transaction ${index + 1} must record ${action}, successful status, and block ${blockNumber}`);
  }
  expect(evidence?.postBroadcast?.allowances?.token === "0", "test-token allowance must be zero");
  expect(evidence?.postBroadcast?.allowances?.weth === "0", "WETH allowance must be zero");
  expect(evidence?.postBroadcast?.nativeBalanceWei === "490303540000000", "unexpected post-broadcast native balance");
  expect(
    Array.isArray(evidence?.webTests?.commands) &&
      evidence.webTests.commands.length === 2 &&
      evidence.webTests.commands[0] === "pnpm -s web:typecheck" &&
      evidence.webTests.commands[1] === "pnpm -s web:test:e2e",
    "unexpected web test commands"
  );
  expect(evidence?.webTests?.passed === 90 && evidence?.webTests?.skipped === 4, "unexpected web test result counts");
  expect(
    Array.isArray(evidence?.webTests?.cases) &&
      evidence.webTests.cases.length === expectedWebCases.length &&
      expectedWebCases.every((name, index) => evidence.webTests.cases[index] === name),
    "degraded-state web test cases are incomplete or reordered"
  );
  expect(typeof evidence?.rehearsal?.command === "string" && evidence.rehearsal.command.includes("--min-bins 101"), "missing 101-bin rehearsal command");
  expect(evidence?.rehearsal?.config?.burnBps === 100 && evidence.rehearsal.config?.minBins === 101 && evidence.rehearsal.config?.maxIndexerLag === 300 && evidence.rehearsal.config?.pageSize === 100, "unexpected rehearsal config");
  expect(result?.ok === true && result?.indexedBlock === 89305193 && result?.rpcHeadBlock === 89305207 && result?.blockLag === 14, "unexpected rehearsal result blocks");
  expect(result?.indexerBlockHash === "0xf63b69eb2f5868a5a6c9967f1de64f6747d3ae1d80656a2c7e254fe70bc3cffe", "unexpected indexed block hash");
  expect(result?.pagination?.pagesFetched === 2 && result?.pagination?.pageSize === 100 && result?.pagination?.positions === 101 && result?.pagination?.firstId === "8388558" && result?.pagination?.lastId === "8388658" && result?.pagination?.count === 101, "unexpected pagination evidence");
  expect(checkMatches("owner-pair-pagination", { pagesFetched: 2, pageSize: 100, positions: 101, capped: false }), "owner-pair pagination check did not pass");
  expect(checkMatches("indexer-freshness", { graphqlBlockNumber: 89305193, blockLag: 14, hasIndexingErrors: false }), "indexer freshness check did not pass");
  expect(checkMatches("same-block-live-reads", { blockNumber: 89305193, binCount: 101 }), "same-block 101-bin read check did not pass");
  expect(checkMatches("current-live-state", { rpcHeadBlock: 89305207, binCount: 101 }), "current 101-bin read check did not pass");
  expect(checkMatches("router-approval") && checkMatches("current-router-approval", { rpcHeadBlock: 89305207 }), "router approval checks did not pass");
  expect(checkMatches("remove-liquidity-simulation", { amountXOut: "4509999999968", amountYOut: "4509999999968" }) && checkMatches("current-remove-liquidity-simulation", { amountXOut: "4509999999968", amountYOut: "4509999999968" }), "remove simulation checks did not pass");
  expect(Array.isArray(result?.launchBlockers) && result.launchBlockers.length === 0, "rehearsal launchBlockers must be empty");
  expect(!/https?:\/\//i.test(JSON.stringify(evidence)), "evidence must not contain raw URLs or credentials");

  return evidenceErrors;
}

function validateManifest(relativePath) {
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(root, "scripts/manifests/validate-manifests.cjs"), relativePath],
    { cwd: root, encoding: "utf8" }
  );

  return {
    path: relativePath,
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`.trim()
  };
}

function defaultRuntimeManifestFiles() {
  const files = [];
  for (const environment of ["testnet", "mainnet"]) {
    for (const name of ["dry-run.json", "latest.json"]) {
      const relativePath = `deployments/robinhood/${environment}/${name}`;
      if (exists(relativePath)) files.push(relativePath);
    }
  }
  return files;
}

function validate() {
  const errors = [];
  const warnings = [];
  const launchBlockers = [];
  let hasRuntimeTestnetMultibinRemoveHappyPathEvidence = false;
  let hasRuntimeTestnetRemoveDegradedStateEvidence = false;
  let hasRuntimeTestnetMultipageRemoveEvidence = false;
  let hasRuntimeTestnetWebArtifactEvidence = false;
  let hasRuntimeTestnetIndexerEvidence = false;
  let hasRuntimeTestnetLaunchHealthEvidence = false;
  let hasRuntimeTestnetOwnershipEvidence = false;
  let hasRuntimeTestnetRpcIndependentDemoEvidence = false;
  let hasRuntimeTestnetContractVerificationEvidence = false;

  if (exists(testnetLaunchPacketPath)) {
    const packetValidation = childProcess.spawnSync(
      process.execPath,
      [path.join(root, "scripts/release/validate-testnet-launch-packet.cjs"), testnetLaunchPacketPath, "--commit-mode", "ancestry"],
      { cwd: root, encoding: "utf8" }
    );
    if (packetValidation.status !== 0) {
      errors.push(`committed testnet launch packet failed validation: ${`${packetValidation.stdout}${packetValidation.stderr}`.trim()}`);
    }
  }
  let paginationEvidence = null;
  let paginationEvidenceValid = false;
  let testnetManifestEvidence = null;
  let testnetManifestEvidenceValid = false;
  const rootPackage = readJson("package.json");
  const scripts = rootPackage.scripts ?? {};

  for (const scriptName of requiredScripts) {
    if (!scripts[scriptName]) {
      errors.push(`package.json missing script: ${scriptName}`);
    }
  }

  for (const [scriptName, command] of Object.entries(scripts)) {
    if (/zap/i.test(scriptName) || /LBZap|zap-in|zap-out/i.test(String(command))) {
      errors.push(`package.json script retains removed on-chain Zap surface: ${scriptName}`);
    }
  }

  for (const removedFile of removedZapFiles) {
    if (exists(removedFile)) errors.push(`removed on-chain Zap file must be absent: ${removedFile}`);
  }

  for (const retiredFile of retiredCloudflareControlFiles) {
    if (exists(retiredFile)) errors.push(`provider-neutral web artifacts must not include Cloudflare control file: ${retiredFile}`);
  }

  for (const [issueId, gateIds] of Object.entries(reviewIssueCoverage)) {
    if (gateIds.length === 0) {
      errors.push(`release gate inventory missing verified review issue coverage: ${issueId}`);
    }
  }

  if (
    scripts["contracts:test:fork"] &&
    (!scripts["contracts:test:fork"].includes("contracts:test:fork:router") ||
      !scripts["contracts:test:fork"].includes("contracts:test:fork:quoter") ||
      !scripts["contracts:test:fork"].includes("contracts:test:fork:priority"))
  ) {
    errors.push("package.json contracts:test:fork must run router, quoter, and priority fork segments explicitly");
  }

  if (scripts["robinhood:rpc:check"] !== "node scripts/robinhood/check-rpc-readiness.cjs") {
    errors.push("package.json robinhood:rpc:check must run scripts/robinhood/check-rpc-readiness.cjs");
  }

  if (scripts["robinhood:rpc:test"] !== "node scripts/robinhood/test-check-rpc-readiness.cjs") {
    errors.push("package.json robinhood:rpc:test must run scripts/robinhood/test-check-rpc-readiness.cjs");
  }

  if (scripts["robinhood:ownership:test"] !== "node scripts/robinhood/test-check-ownership-handoff.cjs") {
    errors.push("package.json robinhood:ownership:test must run scripts/robinhood/test-check-ownership-handoff.cjs");
  }

  if (scripts["robinhood:verify:test"] !== "node scripts/robinhood/test-verify-constructor-args.cjs") {
    errors.push("package.json robinhood:verify:test must run scripts/robinhood/test-verify-constructor-args.cjs");
  }

  if (scripts["graph-node:validate"] !== "node scripts/release/check-self-hosted-graph-node.cjs") {
    errors.push("package.json graph-node:validate must run scripts/release/check-self-hosted-graph-node.cjs");
  }

  if (scripts["launch:health:test"] !== "node scripts/release/test-check-launch-health.cjs") {
    errors.push("package.json launch:health:test must run scripts/release/test-check-launch-health.cjs");
  }

  if (scripts["release:runbooks:validate"] !== "node scripts/release/validate-operator-runbooks.cjs") {
    errors.push("package.json release:runbooks:validate must run the operator runbook validator");
  }

  if (scripts["release:runbooks:test"] !== "node scripts/release/test-validate-operator-runbooks.cjs") {
    errors.push("package.json release:runbooks:test must run the operator runbook validator tests");
  }

  if (scripts["release:web-promotion:test"] !== "node scripts/release/test-web-promotion.cjs") {
    errors.push("package.json release:web-promotion:test must exactly run scripts/release/test-web-promotion.cjs");
  }

  const ciWorkflow = readText(".github/workflows/ci.yml");
  for (const command of ["pnpm release:web-promotion:test", "pnpm release:runbooks:validate", "pnpm release:runbooks:test"]) {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrences = [...ciWorkflow.matchAll(new RegExp(`^\\s*run:\\s*${escaped}\\s*$`, "gm"))].length;
    if (occurrences !== 1) errors.push(`CI workflow must run ${command} exactly once`);
  }

  const subgraphPackage = readJson("indexer/subgraph/package.json");
  const localSubgraphDeploy = subgraphPackage.scripts?.["deploy:local"] ?? "";
  const localRenderIndex = localSubgraphDeploy.indexOf("pnpm generate:local");
  const localCodegenIndex = localSubgraphDeploy.indexOf("graph codegen subgraph.yaml");
  const localDeployIndex = localSubgraphDeploy.indexOf("graph deploy");
  if (
    localRenderIndex < 0 ||
    localCodegenIndex < 0 ||
    localDeployIndex < 0 ||
    localRenderIndex > localCodegenIndex ||
    localCodegenIndex > localDeployIndex
  ) {
    errors.push("indexer/subgraph deploy:local must render its manifest and generate Graph bindings before deployment");
  }

  const graphNodeE2eRunner = readText("scripts/indexer/run-graph-node-e2e.sh");
  if (/zap/i.test(graphNodeE2eRunner)) {
    errors.push("Graph Node E2E runner must not execute removed Zap scenarios");
  }

  if (scripts["web:fixture:public"] !== "node scripts/web/create-public-config-fixture.cjs") {
    errors.push("package.json web:fixture:public must run scripts/web/create-public-config-fixture.cjs");
  }

  if (scripts["web:test:public-config"] !== "node scripts/web/test-public-config.cjs") {
    errors.push("package.json web:test:public-config must run scripts/web/test-public-config.cjs");
  }

  if (scripts["web:validate:public-config"] !== "node scripts/web/validate-public-config.cjs") {
    errors.push("package.json web:validate:public-config must run scripts/web/validate-public-config.cjs");
  }

  if (scripts["web:check:public-artifact"] !== "node scripts/web/check-public-artifact.cjs") {
    errors.push("package.json web:check:public-artifact must run scripts/web/check-public-artifact.cjs");
  }

  if (scripts["web:write:public-headers"] !== undefined) {
    errors.push("package.json must not expose the retired Cloudflare web:write:public-headers script");
  }

  if (scripts["vps:validate"] !== "node scripts/release/validate-vps-deployment.cjs") {
    errors.push("package.json vps:validate must run scripts/release/validate-vps-deployment.cjs");
  }

  if (
    scripts["vps:test"] !==
    "node scripts/release/test-build-analytics-runtime-custody.cjs && node scripts/release/test-validate-vps-deployment.cjs"
  ) {
    errors.push("package.json vps:test must run the custody-builder and VPS validator adversarial suites");
  }

  if (scripts["web:test:e2e"] !== "pnpm --filter @robinhood-lb/web test:e2e") {
    errors.push("package.json web:test:e2e must run the web Playwright suite");
  }

  if (scripts["e2e:localnet"] !== "node scripts/e2e/run-localnet-transactions.cjs") {
    errors.push("package.json e2e:localnet must run scripts/e2e/run-localnet-transactions.cjs");
  }

  if (
    scripts["sdk:e2e:localnet:expected-revert"] !==
    "pnpm --filter @robinhood-lb/sdk e2e:localnet:expected-revert"
  ) {
    errors.push(
      "package.json sdk:e2e:localnet:expected-revert must run the SDK test-only failed-simulation fixture"
    );
  }

  const sdkPackageScripts = readJson("packages/sdk/package.json").scripts ?? {};
  if (
    sdkPackageScripts["e2e:localnet:expected-revert"] !==
    "pnpm build && node dist/test/localnet-expected-revert-fixture.js"
  ) {
    errors.push("SDK expected-revert E2E must run the test-only localnet fixture");
  }
  if (sdkPackageScripts["example:localnet:expected-revert"] !== undefined) {
    errors.push("the failed-simulation negative path must not be exposed as a positive SDK example");
  }
  if (exists("packages/sdk/examples/localnet-expected-revert.ts")) {
    errors.push("the failed-simulation negative path must remain under packages/sdk/test, not examples");
  }

  const localnetTransactionRunner = readText("scripts/e2e/run-localnet-transactions.cjs");
  for (const token of [
    "sdk:e2e:localnet:expected-revert",
    "result.exitCode !== 0",
    "result.signal === null",
    "result.spawnError === null",
    "result.status === null ? 1 : result.status",
    "broadcastAttempted === false",
    "nonceBefore === parsed?.nonceAfter",
    "parsed?.revertHash === undefined",
    "parsed?.transactionHash === undefined"
  ]) {
    if (!localnetTransactionRunner.includes(token)) {
      errors.push(`localnet transaction runner missing failed-simulation proof: ${token}`);
    }
  }

  if (
    scripts["web:build:public:testnet"] &&
    (!scripts["web:build:public:testnet"].includes("pnpm web:validate:public-config") ||
      !scripts["web:build:public:testnet"].includes("--environment robinhoodTestnet") ||
      !scripts["web:build:public:testnet"].includes("pnpm web:validate:public-runtime") ||
      !scripts["web:build:public:testnet"].includes("VITE_PUBLIC_RELEASE_ENV=robinhoodTestnet") ||
      !scripts["web:build:public:testnet"].includes("pnpm web:build") ||
      scripts["web:build:public:testnet"].includes("web:write:public-headers"))
  ) {
    errors.push("package.json web:build:public:testnet must validate, set VITE_PUBLIC_RELEASE_ENV, and emit a provider-neutral web build");
  }

  if (
    scripts["web:build:public:mainnet"] &&
    (!scripts["web:build:public:mainnet"].includes("pnpm web:validate:public-config") ||
      !scripts["web:build:public:mainnet"].includes("--environment robinhood") ||
      !scripts["web:build:public:mainnet"].includes("pnpm web:validate:public-runtime") ||
      !scripts["web:build:public:mainnet"].includes("VITE_PUBLIC_RELEASE_ENV=robinhood") ||
      !scripts["web:build:public:mainnet"].includes("pnpm web:build") ||
      scripts["web:build:public:mainnet"].includes("web:write:public-headers"))
  ) {
    errors.push("package.json web:build:public:mainnet must validate, set VITE_PUBLIC_RELEASE_ENV, and emit a provider-neutral web build");
  }

  if (
    scripts["indexer:test:smoke:robinhood"] &&
    (!scripts["indexer:test:smoke:robinhood"].includes("test-validate-smoke-robinhood.cjs") ||
      !scripts["indexer:test:smoke:robinhood"].includes("test-smoke-robinhood-wrapper.cjs"))
  ) {
    errors.push("package.json indexer:test:smoke:robinhood must run validator and wrapper fixture tests");
  }

  if (
    scripts["contracts:test:full"] &&
    (!scripts["contracts:test:full"].includes("--gas-limit 4000000000") ||
      !scripts["contracts:test:full"].includes("contracts/joe-v2/test/integration/*") ||
      !scripts["contracts:test:full"].includes("GetOracleLengthTest"))
  ) {
    errors.push("package.json contracts:test:full must set the upstream oracle stress gas limit and exclude provider-backed tests");
  }

  for (const scriptName of ["contracts:test:fork:router", "contracts:test:fork:quoter", "contracts:test:fork:priority"]) {
    if (scripts[scriptName] && !scripts[scriptName].includes("require-fork-rpc.cjs")) {
      errors.push(`package.json ${scriptName} must fail fast through require-fork-rpc.cjs when provider RPC is missing`);
    }
  }

  if (
    scripts["contracts:test:exhaustive"] &&
    (!scripts["contracts:test:exhaustive"].includes("contracts:test:full") ||
      !scripts["contracts:test:exhaustive"].includes("contracts:test:fork"))
  ) {
    errors.push("package.json contracts:test:exhaustive must run full local tests and all fork segments");
  }

  for (const doc of requiredDocs) {
    if (!exists(doc)) {
      errors.push(`missing required runbook: ${doc}`);
    }
  }

  if (exists("docs/provenance/dependency-license-report.md")) {
    const reportDoc = readText("docs/provenance/dependency-license-report.md");
    for (const token of [
      "Full Node Dependency Inventory",
      "Full Node inventory sha256",
      "Full Solidity SPDX Inventory",
      "Lockfile sha256",
      "Resolved cross-platform packages scanned",
      "Platform-Restricted Optional Packages",
      "Direct Nested OpenZeppelin Submodule Declarations"
    ]) {
      if (!reportDoc.includes(token)) {
        errors.push(`dependency-license-report.md missing required evidence section: ${token}`);
      }
    }
  }

  if (exists("docs/provenance/license-exceptions.md")) {
    const exceptionsDoc = readText("docs/provenance/license-exceptions.md");
    for (const token of [
      "Owner",
      "Risk",
      "Mitigation",
      "Launch decision",
      "Nested OpenZeppelin test submodules",
      "Platform-restricted optional native build packages"
    ]) {
      if (!exceptionsDoc.includes(token)) {
        errors.push(`license-exceptions.md missing required exception field: ${token}`);
      }
    }
  }

  if (exists("docs/wave-2/token-list-policy.md")) {
    const tokenListPolicy = readText("docs/wave-2/token-list-policy.md");
    for (const token of [
      "committed SDK token lists are canonical",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      "disabledActions",
      "fee-on-transfer",
      "manifest quote-asset reconciliation"
    ]) {
      if (!tokenListPolicy.includes(token)) {
        errors.push(`token-list-policy.md missing required #49 policy evidence: ${token}`);
      }
    }
  }

  for (const file of requiredFiles) {
    if (!exists(file)) {
      errors.push(`missing required release artifact: ${file}`);
    }
  }

  if (exists(paginationEvidencePath)) {
    try {
      paginationEvidence = readJson(paginationEvidencePath);
      const evidenceErrors = validatePaginationEvidence(paginationEvidence);
      if (evidenceErrors.length === 0) {
        paginationEvidenceValid = true;
      } else {
        for (const error of evidenceErrors) errors.push(`${paginationEvidencePath}: ${error}`);
      }
    } catch (error) {
      errors.push(`${paginationEvidencePath} must be valid JSON: ${error.message}`);
    }
  }

  if (exists(testnetManifestEvidencePath)) {
    const manifestValidation = validateManifest(testnetManifestEvidencePath);
    if (!manifestValidation.ok) {
      errors.push(`${testnetManifestEvidencePath} failed manifest validation: ${manifestValidation.output}`);
    } else {
      try {
        testnetManifestEvidence = readJson(testnetManifestEvidencePath);
        const snapshotHash = sha256(testnetManifestEvidencePath);
        if (snapshotHash !== paginationEvidence?.manifest?.sha256) {
          errors.push(`${testnetManifestEvidencePath} SHA-256 does not match the pagination evidence manifest hash`);
        } else {
          testnetManifestEvidenceValid = true;
        }
      } catch (error) {
        errors.push(`${testnetManifestEvidencePath} must be valid JSON: ${error.message}`);
      }
    }
  }

  const committedEvidenceCorrelation =
    paginationEvidenceValid &&
    testnetManifestEvidenceValid &&
    paginationEvidence?.chainId === testnetManifestEvidence?.chainId &&
    lower(paginationEvidence?.router) === lower(testnetManifestEvidence?.contracts?.lbRouter) &&
    lower(paginationEvidence?.tokens?.weth) === lower(testnetManifestEvidence?.quoteAssets?.wrappedNative);
  if (paginationEvidenceValid && testnetManifestEvidenceValid && !committedEvidenceCorrelation) {
    errors.push("pagination evidence does not match the committed Robinhood testnet manifest snapshot");
  }
  if (!runtimeManifests) {
    hasRuntimeTestnetMultibinRemoveHappyPathEvidence = committedEvidenceCorrelation;
    hasRuntimeTestnetRemoveDegradedStateEvidence = committedEvidenceCorrelation;
    hasRuntimeTestnetMultipageRemoveEvidence = committedEvidenceCorrelation;
  }

  const staticAnalysisTriage = childProcess.spawnSync(
    process.execPath,
    [path.join(root, "scripts/release/check-static-analysis-triage.cjs"), "--json"],
    { cwd: root, encoding: "utf8" }
  );
  let staticAnalysisTriageReport = null;
  try {
    staticAnalysisTriageReport = JSON.parse(staticAnalysisTriage.stdout || "{}");
  } catch {
    // Fall back to raw output below.
  }
  if (staticAnalysisTriage.status !== 0) {
    if (Array.isArray(staticAnalysisTriageReport?.errors) && staticAnalysisTriageReport.errors.length > 0) {
      for (const error of staticAnalysisTriageReport.errors) {
        errors.push(`static analysis triage: ${error}`);
      }
    } else {
      const output = `${staticAnalysisTriage.stdout}${staticAnalysisTriage.stderr}`.trim();
      errors.push(output || "static analysis triage register validation failed");
    }
  }
  for (const warning of staticAnalysisTriageReport?.warnings ?? []) {
    warnings.push(`static analysis triage: ${warning}`);
  }

  const ci = readText(".github/workflows/ci.yml");
  const ciFoundrySetups = ci.split("uses: foundry-rs/foundry-toolchain@").length - 1;
  const ciPinnedFoundryVersions = ci.split("version: v1.4.1").length - 1;
  if (ciFoundrySetups === 0 || ciPinnedFoundryVersions !== ciFoundrySetups) {
    errors.push("CI Foundry setup steps must pin the documented v1.4.1 toolchain");
  }
  for (const requiredStep of [
    "Validate Wave 2 release gates",
    "Test Robinhood RPC readiness helper",
    "Test remove-liquidity rehearsal batching",
    "Test Robinhood ownership handoff helper",
    "Test Robinhood verification helper",
    "Validate self-hosted Graph Node compose",
    "Test launch health helper",
    "Validate dependency provenance",
    "Check dependency provenance report",
    "Test web GraphQL pagination",
    "Test web pool selection",
    "Test web position burn planning",
    "Test web transaction safety",
    "Install Playwright Chromium",
    "Test web wallet-state E2E",
    "Upload Playwright wallet-state artifacts",
    "Test web public config fixtures",
    "Build and check synthetic public testnet web artifact",
    "Build and check synthetic public mainnet web artifact",
    "Run deterministic localnet transactions",
    "Upload localnet E2E artifacts",
    "Build subgraph",
    "Build Robinhood testnet subgraph",
    "Build Robinhood mainnet subgraph",
    "Test Robinhood smoke path",
    "Run Slither advisory scan"
  ]) {
    if (!ci.includes(requiredStep)) {
      errors.push(`CI missing required step: ${requiredStep}`);
    }
  }
  if (!ci.includes("run: pnpm robinhood:rpc:test")) {
    errors.push("CI must run `pnpm robinhood:rpc:test` for the RPC readiness helper");
  }
  if (!ci.includes("run: pnpm robinhood:remove-liquidity:test")) {
    errors.push("CI must run `pnpm robinhood:remove-liquidity:test` for batched pinned-read coverage");
  }
  if (!ci.includes("run: pnpm robinhood:ownership:test")) {
    errors.push("CI must run `pnpm robinhood:ownership:test` for the ownership handoff helper");
  }
  if (!ci.includes("run: pnpm robinhood:verify:test")) {
    errors.push("CI must run `pnpm robinhood:verify:test` for constructor-arg verification coverage");
  }
  if (!ci.includes("run: pnpm graph-node:validate")) {
    errors.push("CI must run `pnpm graph-node:validate` for the self-hosted Graph Node fallback");
  }
  if (!ci.includes("run: pnpm launch:health:test")) {
    errors.push("CI must run `pnpm launch:health:test` for the launch health helper");
  }
  if (!ci.includes("run: pnpm web:test:e2e")) {
    errors.push("CI must run `pnpm web:test:e2e` for wallet-state browser coverage");
  }
  if (!ci.includes("run: pnpm e2e:localnet")) {
    errors.push("CI must run `pnpm e2e:localnet` for deterministic localnet transactions");
  }
  if (!ci.includes("playwright-wallet-state-e2e")) {
    errors.push("CI must upload Playwright wallet-state artifacts for actionable E2E failures");
  }
  if (!ci.includes("localnet-e2e-logs")) {
    errors.push("CI must upload deterministic localnet E2E logs");
  }
  if (!ci.includes("pnpm web:test:public-config")) {
    errors.push("CI must run `pnpm web:test:public-config` for public web config fixtures");
  }
  if (!ci.includes("pnpm web:fixture:public")) {
    errors.push("CI must create a synthetic public web manifest fixture");
  }
  if (!ci.includes("pnpm web:build:public:testnet")) {
    errors.push("CI must build a synthetic public Robinhood testnet web artifact");
  }
  if (!ci.includes("pnpm web:build:public:mainnet")) {
    errors.push("CI must build a synthetic public Robinhood mainnet web artifact");
  }
  if (!ci.includes("pnpm web:check:public-artifact")) {
    errors.push("CI must check the synthetic public web artifact");
  }

  const upstreamWorkflowPath = ".github/workflows/contracts-upstream.yml";
  if (!exists(upstreamWorkflowPath)) {
    errors.push(`missing required contract test workflow: ${upstreamWorkflowPath}`);
  } else {
    const upstreamWorkflow = readText(upstreamWorkflowPath);
    const upstreamFoundrySetups = upstreamWorkflow.split("uses: foundry-rs/foundry-toolchain@").length - 1;
    const upstreamPinnedFoundryVersions = upstreamWorkflow.split("version: v1.4.1").length - 1;
    if (upstreamFoundrySetups === 0 || upstreamPinnedFoundryVersions !== upstreamFoundrySetups) {
      errors.push(`${upstreamWorkflowPath} Foundry setup steps must pin the documented v1.4.1 toolchain`);
    }
    for (const token of [
      "workflow_dispatch",
      "schedule",
      "full-local",
      "fork-router",
      "fork-quoter",
      "fork-priority",
      "fork-all",
      "exhaustive",
      "AVALANCHE_RPC_URL",
      "pnpm contracts:test:exhaustive"
    ]) {
      if (!upstreamWorkflow.includes(token)) {
        errors.push(`${upstreamWorkflowPath} missing required #16 workflow token: ${token}`);
      }
    }
  }

  for (const foundryFile of ["foundry.toml", "contracts/joe-v2/foundry.toml"]) {
    const foundryConfig = readText(foundryFile);
    if (!foundryConfig.includes('avalanche = "${AVALANCHE_RPC_URL}"')) {
      errors.push(`${foundryFile} must source the Avalanche fork RPC from AVALANCHE_RPC_URL`);
    }
    if (!foundryConfig.includes('fuji = "${FUJI_RPC_URL}"')) {
      errors.push(`${foundryFile} must source the Fuji fork RPC from FUJI_RPC_URL`);
    }
    if (foundryConfig.includes("https://api.avax.network") || foundryConfig.includes("https://api.avax-test.network")) {
      errors.push(`${foundryFile} must not commit public Avalanche/Fuji RPC URLs`);
    }
  }

  for (const envExample of [".env.example", "contracts/joe-v2/.env.example"]) {
    const envText = readText(envExample);
    for (const token of ["AVALANCHE_RPC_URL", "FUJI_RPC_URL"]) {
      if (!envText.includes(token)) {
        errors.push(`${envExample} missing fork RPC variable: ${token}`);
      }
    }
    if (envText.includes("https://api.avax.network") || envText.includes("https://api.avax-test.network")) {
      errors.push(`${envExample} must not commit public Avalanche/Fuji RPC URLs`);
    }
  }

  if (exists("docs/wave-2/full-upstream-test-modes.md")) {
    const upstreamTestModes = readText("docs/wave-2/full-upstream-test-modes.md");
    for (const token of ["full-local", "fork-all", "exhaustive", "AVALANCHE_RPC_URL", "CI Decision Record", "require-fork-rpc.cjs"]) {
      if (!upstreamTestModes.includes(token)) {
        errors.push(`full-upstream-test-modes.md missing required #16 evidence: ${token}`);
      }
    }
  }

  if (exists("docs/wave-2/rpc-archive-provider-readiness.md")) {
    const rpcReadiness = readText("docs/wave-2/rpc-archive-provider-readiness.md");
    for (const token of [
      "pnpm robinhood:rpc:check",
      "ROBINHOOD_ARCHIVE_RPC_URL",
      "ROBINHOOD_MAINNET_ARCHIVE_RPC_URL",
      "ROBINHOOD_TESTNET_ARCHIVE_RPC_URL",
      "ROBINHOOD_FALLBACK_RPC_URL",
      "ROBINHOOD_MAINNET_FALLBACK_RPC_URL",
      "ROBINHOOD_TESTNET_FALLBACK_RPC_URL",
      "ROBINHOOD_RPC_READINESS_RPC_URL",
      "ROBINHOOD_RPC_CHECK_FACTORY_BLOCK",
      "ROBINHOOD_RPC_CHECK_PAIR_BLOCK",
      "public Robinhood RPC",
      "Rotation plan",
      "Expected monthly cost"
    ]) {
      if (!rpcReadiness.includes(token)) {
        errors.push(`rpc-archive-provider-readiness.md missing required #47 evidence: ${token}`);
      }
    }
  }

  if (exists("docs/wave-2/public-environment-config.md")) {
    const publicEnvironmentConfig = readText("docs/wave-2/public-environment-config.md");
    for (const token of [
      "pnpm web:test:public-config",
      "pnpm web:check:public-artifact",
      "infra/vps/Caddyfile",
      "infra/vps/compose.yml",
      "pnpm vps:validate",
      "pnpm vps:test",
      "provider-neutral",
      "secret canary"
    ]) {
      if (!publicEnvironmentConfig.includes(token)) {
        errors.push(`public-environment-config.md missing required #43 evidence: ${token}`);
      }
    }
  }

  if (exists("docs/wave-2/liquidity-composition-decision.md")) {
    const liquidityComposition = readText("docs/wave-2/liquidity-composition-decision.md");
    for (const token of [
      "Issue #48",
      "No On-Chain Zap",
      "addLiquidityNATIVE",
      "one-sided",
      "separate transactions",
      "non-atomic",
      "contracts.zap",
      "ZapIn",
      "ZapOut"
    ]) {
      if (!liquidityComposition.includes(token)) {
        errors.push(`liquidity-composition-decision.md missing required scope evidence: ${token}`);
      }
    }
  }

  if (exists("docs/wave-2/audit-readiness-package.md")) {
    const auditReadiness = readText("docs/wave-2/audit-readiness-package.md");
    for (const token of [
      "Issue #41",
      "Scope",
      "Out Of Scope",
      "Security Objectives",
      "Evidence Index",
      "Auditor Handoff",
      "Required Audit Questions",
      "External Finding Response",
      "Live-Only Blockers",
      "Response SLA",
      "Regression test",
      "LBFactory",
      "LBPair",
      "LBRouter",
      "LBQuoter",
      "No on-chain Zap",
      "release:gates",
      "release:provenance:check",
      "robinhood:ownership:check",
      "robinhood:rpc:check",
      "indexer:test:smoke:robinhood",
      "web:check:public-artifact",
      "launch:health"
    ]) {
      if (!auditReadiness.includes(token)) {
        errors.push(`audit-readiness-package.md missing required #41 evidence: ${token}`);
      }
    }
  }

  if (exists("docs/wave-2/threat-model.md")) {
    const threatModel = readText("docs/wave-2/threat-model.md");
    for (const token of [
      "Issue #41",
      "System Boundary",
      "Assets",
      "Trust Boundaries",
      "Attacker Goals",
      "Threats And Mitigations",
      "Invariants For Review",
      "Residual Risk",
      "Robinhood Chain",
      "Graph Node",
      "Goldsky",
      "non-atomic liquidity composition",
      "LBFactory",
      "LBPair",
      "LBRouter",
      "LBQuoter",
      "LBToken",
      "flash-loan",
      "oracle",
      "batch-transfer",
      "MEV",
      "Privileged owner",
      "infra/vps/Caddyfile",
      "pnpm vps:validate"
    ]) {
      if (!threatModel.includes(token)) {
        errors.push(`threat-model.md missing required #41 evidence: ${token}`);
      }
    }
  }

  for (const manifest of [
    "deployments/examples/localnet.example.json",
    "deployments/examples/robinhood-testnet.example.json",
    "deployments/examples/robinhood-mainnet.example.json"
  ]) {
    const result = validateManifest(manifest);
    if (!result.ok) {
      errors.push(`${manifest} failed manifest validation: ${result.output}`);
    }
  }

  const runtimeResults = runtimeManifests ? defaultRuntimeManifestFiles().map(validateManifest) : [];
  for (const result of runtimeResults) {
    if (!result.ok) {
      errors.push(`${result.path} failed runtime manifest validation: ${result.output}`);
    }
  }

  if (!runtimeManifests && defaultRuntimeManifestFiles().length > 0) {
    warnings.push("Ignored Robinhood runtime manifests are present; run `pnpm release:gates -- --runtime-manifests` before using them as release evidence.");
  }

  if (exists("deployments/robinhood/testnet/latest.json") || exists("deployments/robinhood/mainnet/latest.json")) {
    warnings.push("A broadcast Robinhood latest.json exists locally; confirm it is from the intended deployer and release commit before attaching evidence.");
  }

  if (runtimeManifests) {
    const runtimeTestnetManifestPath = "deployments/robinhood/testnet/latest.json";
    let testnetManifest = null;
    let testnetManifestHash = null;
    if (!exists(runtimeTestnetManifestPath)) {
      errors.push(`${runtimeTestnetManifestPath} is required when --runtime-manifests is passed`);
    } else {
      testnetManifest = readJson(runtimeTestnetManifestPath);
      testnetManifestHash = sha256(runtimeTestnetManifestPath);
      const paginationEvidenceMatchesManifest =
        committedEvidenceCorrelation &&
        paginationEvidence?.manifest?.sha256 === testnetManifestHash &&
        paginationEvidence?.chainId === testnetManifest.chainId &&
        lower(paginationEvidence?.router) === lower(testnetManifest.contracts?.lbRouter) &&
        lower(paginationEvidence?.tokens?.weth) === lower(testnetManifest.quoteAssets?.wrappedNative);
      if (!paginationEvidenceMatchesManifest) {
        errors.push("runtime Robinhood testnet manifest does not match the committed evidence manifest snapshot");
      } else {
        hasRuntimeTestnetMultibinRemoveHappyPathEvidence = true;
        hasRuntimeTestnetRemoveDegradedStateEvidence = true;
        hasRuntimeTestnetMultipageRemoveEvidence = true;
      }
    }

    if (testnetManifest && testnetManifestHash) {
      const rpcEvidencePath = "docs/wave-2/robinhood-testnet-rpc-readiness-evidence.md";
      if (exists(rpcEvidencePath)) {
      const rpcEvidence = readText(rpcEvidencePath);
      hasRuntimeTestnetRpcIndependentDemoEvidence = includesAll(rpcEvidence, [
        testnetManifestHash,
        lower(testnetManifest.contracts?.lbFactory),
        lower(testnetManifest.endpoints?.rpcUrl),
        "https://explorer.testnet.chain.robinhood.com/api/eth-rpc",
        "https://docs-demo.robinhood-testnet.quiknode.pro",
        "--archive-rpc-url",
        "--fallback-rpc-url",
        "--factory-deployment-block",
        '"ok": true',
        '"name": "primary-rpc"',
        '"name": "archive-rpc"',
        '"name": "fallback-rpc"',
        '"name": "historical-block"',
        '"name": "historical-factory-owner-call"',
        '"name": "historical-factory-log-sample"',
        '"name": "pair-latest-methods"',
        '"name": "pair-historical-methods"',
        '"launchBlockers": []',
        "customer-origin.offchainlabs.com",
        "Explorer is archive-only",
        "shared/testnet-only",
        "5 RPS",
        "durable project-owned testnet fallback",
        "Mainnet still requires"
      ]);
      }

      const verificationEvidencePath = "docs/wave-2/robinhood-testnet-contract-verification-evidence.md";
      if (exists(verificationEvidencePath)) {
      const verificationEvidence = readText(verificationEvidencePath);
      hasRuntimeTestnetContractVerificationEvidence = includesAll(verificationEvidence, [
        testnetManifestHash,
        lower(testnetManifest.contracts?.lbFactory),
        lower(testnetManifest.contracts?.lbPairImplementation),
        lower(testnetManifest.contracts?.lbRouter),
        lower(testnetManifest.contracts?.lbQuoter),
        lower(testnetManifest.sourceJoeV2Commit),
        "pnpm -s robinhood:verify",
        "Pass - Verified",
        "Contract successfully verified",
        '"status":"1"',
        '"message":"OK"',
        "v0.8.20+commit.a1b79de6",
        "Optimization runs",
        "800",
        "Mainnet verification"
      ]);
      }

      if (typeof testnetManifest.endpoints?.indexerUrl === "string" && testnetManifest.endpoints.indexerUrl.length > 0) {
      const evidencePath = "docs/wave-2/robinhood-goldsky-testnet-evidence.md";
      if (!exists(evidencePath)) {
        errors.push(`${evidencePath} is required when a runtime testnet manifest records an indexer endpoint.`);
      } else {
        const evidence = readText(evidencePath);
        let missingEvidenceToken = false;
        for (const token of [
          "pnpm -s indexer:smoke:robinhood",
          "INDEXER_ROBINHOOD_EXPECT_PAIRS",
          "requiredActivity",
          "rpcChecks",
          "blockHash",
          lower(testnetManifest.contracts?.lbFactory),
          lower(testnetManifest.endpoints.indexerUrl)
        ]) {
          if (!evidence.toLowerCase().includes(String(token).toLowerCase())) {
            missingEvidenceToken = true;
            errors.push(`${evidencePath} missing runtime indexer evidence token: ${token}`);
          }
        }
        hasRuntimeTestnetIndexerEvidence = !missingEvidenceToken;

        hasRuntimeTestnetWebArtifactEvidence = includesAll(evidence, [
          "pnpm -s web:build:public:testnet",
          "pnpm -s web:check:public-artifact",
          "apps/web/dist/index.html",
          "apps/web/dist/_headers",
          "apps/web/dist/_redirects",
          "Artifact hashes",
          "Hosted domain, TLS, deployed browser smoke, and rollback evidence remain"
        ]);

        hasRuntimeTestnetOwnershipEvidence = includesAll(evidence, [
          "pnpm -s robinhood:ownership:check",
          "--strict-launch",
          "--expected-owner",
          "--expected-fee-recipient",
          "Accept ownership",
          '"ok": true',
          '"launchBlockers": []',
          '"name": "factory-owner"',
          '"name": "factory-fee-recipient"',
          '"name": "factory-default-admin-deployer"',
          "0x06e34e8eee7087ddd5969be1cbbac3b7228e090e"
        ]);

        hasRuntimeTestnetLaunchHealthEvidence = includesAll(evidence, [
          "pnpm -s launch:health",
          "--strict-launch",
          "--graphql-url",
          "--max-indexer-lag",
          '"ok": true',
          '"launchBlockers": []',
          '"name": "graphql"',
          '"factoryFound": true',
          '"blockLag"'
        ]);
      }
      }
    }
  }

  if (!hasRuntimeTestnetMultibinRemoveHappyPathEvidence) {
    launchBlockers.push(
      "Issue #29 remains launch-blocking until live multi-bin remove-liquidity rehearsal evidence proves owner+pair pagination, same-click `LBPair.balanceOf` reads, deterministic `ids`/`amounts`, and successful remove-liquidity simulation for the production wallet and pair on the selected Robinhood RPC and subgraph endpoints."
    );
  } else if (!hasRuntimeTestnetRemoveDegradedStateEvidence) {
    launchBlockers.push(
      "Issue #29 degraded-state evidence remains launch-blocking until stale-indexer, partial-indexer, and live/indexed mismatch states block before wallet prompt and those screenshots or command outputs are attached alongside the live multi-bin happy-path rehearsal."
    );
  }

  if (!hasRuntimeTestnetMultipageRemoveEvidence) {
    launchBlockers.push(
      "Issue #62/#29 multi-page owner-position pagination remains launch-blocking until live >100-bin owner+pair pagination evidence proves the remove-liquidity flow paginates beyond the first 100 positions, or an explicit launch exception records why no production pool can exceed one page."
    );
  }

  if (!hasRuntimeTestnetOwnershipEvidence) {
    launchBlockers.push(
      'Issue #52 remains launch-blocking until strict `pnpm --silent robinhood:ownership:check -- <latest.json> --strict-launch --rpc-url "$ROBINHOOD_OWNERSHIP_RPC_URL" --expected-owner "$ROBINHOOD_PRODUCTION_OWNER" --expected-fee-recipient "$ROBINHOOD_FEE_RECIPIENT" --json` output proves the post-handoff LBFactory owner and fee recipient. Required env vars: ROBINHOOD_OWNERSHIP_RPC_URL, ROBINHOOD_PRODUCTION_OWNER, ROBINHOOD_FEE_RECIPIENT.'
    );
  } else {
    launchBlockers.push(
      "Issue #52 mainnet production ownership remains launch-blocking until strict ownership output for the approved mainnet or candidate manifest proves the final multisig/governance owner, fee recipient, signer/threshold policy, pending-owner zero state, and deployer privilege removal."
    );
  }

  if (!hasRuntimeTestnetLaunchHealthEvidence) {
    launchBlockers.push(
      "Issue #61 remains launch-blocking until strict `pnpm launch:health` output, alert routing, and tabletop/test-alert rehearsal evidence are attached for the selected Robinhood RPC and indexer endpoints."
    );
  } else {
    launchBlockers.push(
      "Issue #61 mainnet/candidate strict launch-health remains launch-blocking until `pnpm launch:health -- --strict-launch` output is attached for the approved mainnet or final candidate manifest, RPC, indexer, owner, and fee recipient."
    );
    launchBlockers.push(
      "Issue #61 observability remains launch-blocking until alert routing and tabletop/test-alert rehearsal evidence are attached for the selected Robinhood RPC and indexer endpoints."
    );
  }

  if (!hasRuntimeTestnetRpcIndependentDemoEvidence) {
    launchBlockers.push(
      'Issue #47 functional testnet RPC evidence remains launch-blocking until strict `pnpm --silent robinhood:rpc:check -- <latest.json> --strict-launch --rpc-url "$ROBINHOOD_RPC_URL" --archive-rpc-url "$ROBINHOOD_ARCHIVE_RPC_URL" --fallback-rpc-url "$ROBINHOOD_FALLBACK_RPC_URL" --factory-deployment-block "$ROBINHOOD_RPC_CHECK_FACTORY_BLOCK" --pair "$ROBINHOOD_RPC_CHECK_PAIR" --pair-historical-block "$ROBINHOOD_RPC_CHECK_PAIR_BLOCK" --json` output proves primary head reads, retained archive reads, independent-provider fallback head reads, and indexer-start, factory-deployment, and historical pair reads.'
    );
  }
  launchBlockers.push(
    "Issue #47 durable testnet RPC fallback remains launch-blocking until the shared, testnet-only QuickNode demo (5 RPS) is replaced by a project-owned endpoint/account with documented quota, SLA/escalation, protected-secret ownership, and provider/account/failure-domain independence, and a failover rehearsal is attached. The demo proves functional independent-provider fallback only; Explorer is archive-only."
  );
  launchBlockers.push(
    "Issue #47 mainnet production RPC readiness remains launch-blocking until project-owned primary/fallback provider accounts with documented provider/account/failure-domain independence, quotas/SLA/escalation, protected-secret ownership, and strict chain ID 4663 deployment/event-block evidence are attached."
  );

  if (!hasRuntimeTestnetIndexerEvidence) {
    launchBlockers.push(
      "Indexer live endpoint evidence remains launch-blocking under #42/#47/#55 until Goldsky or self-hosted Graph Node returns a Robinhood endpoint that passes `pnpm indexer:smoke:robinhood` against the selected indexer RPC."
    );
  }

  if (!hasRuntimeTestnetWebArtifactEvidence) {
    launchBlockers.push(
      "Issue #43 remains launch-blocking until a promoted public web artifact is built from the selected Robinhood manifest, `pnpm web:check:public-artifact` passes for the local release artifact, and hosted domain/TLS/deployed smoke/rollback evidence is attached."
    );
  } else {
    launchBlockers.push(
      "Issue #43 hosting remains launch-blocking until domain/TLS, deployed smoke, and rollback evidence are attached for the promoted public web artifact."
    );
  }

  launchBlockers.push(
    "Issue #46 remains launch-blocking until live Robinhood testnet core web-flow evidence proves manifest-backed pools and token metadata, swap, add-liquidity, remove-liquidity, positions, and safe missing-liquidity, stale-indexer, unsupported-token, and no-route states against the selected RPC and indexer endpoints. Do not satisfy this by adding ERC20Mock or mock-labeled test tokens to public token lists."
  );

  if (!hasRuntimeTestnetContractVerificationEvidence) {
    launchBlockers.push(
      "Issue #53 remains launch-blocking until live contract verification links, provider-gated fork or approved exception evidence, static-analysis/provenance evidence, and release-owner/security sign-off are attached for the promoted release commit."
    );
  } else {
    launchBlockers.push(
      "Issue #53 mainnet verification and security sign-off remain launch-blocking until the approved chain ID 4663 manifest has reproducible Blockscout links, provider-gated fork output or an approved exception, and release-owner/external-audit approval. Robinhood testnet Factory, Pair implementation, Router, and Quoter verification is proven."
    );
  }

  launchBlockers.push(
    "Issue #55 remains launch-blocking until the end-to-end Robinhood testnet rehearsal packet includes deploy, verify, manifest promotion, pair creation, add/remove liquidity, swap, position read, transaction hashes, verified links, hosted frontend/indexer endpoints, screenshots or command output, failures/remediation notes, rollback, and operator sign-off evidence."
  );

  const examples = [
    readJson("deployments/examples/robinhood-testnet.example.json"),
    readJson("deployments/examples/robinhood-mainnet.example.json")
  ];
  for (const manifest of examples) {
    const env = manifest.environment;
    const args = manifest.constructorArgs ?? {};
    for (const key of ["routerFactoryV1", "routerFactoryV2_1", "routerLegacyFactoryV2", "routerLegacyRouterV2"]) {
      if (args[key] !== zeroAddress) {
        launchBlockers.push(`Issue #15 violation: ${env} example manifest ${key} must remain zero unless legacy routing is reapproved.`);
      }
    }
  }

  const preMainnet = exists("docs/wave-2/pre-mainnet-launch-gate.md")
    ? readText("docs/wave-2/pre-mainnet-launch-gate.md")
    : "";
  for (const token of [
    "#16",
    "#19",
    "#36",
    "#37",
    "#41",
    "#47",
    "#48",
    "audit-readiness-package.md",
    "threat-model.md",
    "release:gates",
    "release:provenance",
    "release:provenance:check"
  ]) {
    if (!preMainnet.includes(token)) {
      warnings.push(`pre-mainnet launch gate should reference ${token}`);
    }
  }

  launchBlockers.push(
    "Issue #41 remains launch-blocking until an external audit package, threat model review, remediation tracker, and final security sign-off are attached to the release ticket, or every audit exception has an owner, expiration date, affected component, compensating control, and explicit mainnet approval."
  );

  if (strictLaunch) {
    for (const blocker of launchBlockers) {
      errors.push(`strict launch blocker: ${blocker}`);
    }
  }

  const repositoryChecksOk = errors.length === 0;
  const mainnetLaunchReady = repositoryChecksOk && launchBlockers.length === 0;
  return {
    repositoryChecksOk,
    mainnetLaunchReady,
    errors,
    warnings,
    launchBlockers,
    runtimeManifestResults: runtimeResults
  };
}

function toMarkdown(report) {
  const lines = [
    "# Wave 2 Release Gate Inventory",
    "",
    `Strict launch mode: \`${strictLaunch ? "on" : "off"}\``,
    `Runtime manifest validation: \`${runtimeManifests ? "on" : "off"}\``,
    `Repository checks: \`${report.repositoryChecksOk ? "pass" : "fail"}\``,
    `Mainnet launch ready: \`${report.mainnetLaunchReady ? "yes" : "no"}\``,
    "",
    "## Gates",
    "",
    "| Gate | Issue | Policy | Lane | Command or evidence |",
    "| --- | --- | --- | --- | --- |"
  ];

  for (const [id, issue, policy, lane, command] of gates) {
    lines.push(`| ${id} | ${issue} | ${policy} | ${lane} | \`${command.replaceAll("|", "\\|")}\` |`);
  }

  lines.push("", "## Validation", "");
  pushStatus(lines, "Fail", report.errors);
  pushStatus(lines, "Warn", report.warnings);
  pushStatus(lines, "Launch blocker", report.launchBlockers);
  if (report.errors.length === 0 && report.warnings.length === 0 && report.launchBlockers.length === 0) {
    lines.push("- Pass: required scripts, runbooks, CI hooks, and manifest fixtures are present.");
  }

  lines.push("", "## External Blockers", "");
  lines.push("- Fork tests need a stable provider RPC before they can be promoted beyond manual/provider-gated.");
  lines.push("- Robinhood deploy, verify, public web, and rendered subgraph gates need live manifests, protected credentials, and release-owner evidence.");
  lines.push("- Goldsky deploy and self-hosted Graph Node fallback require selected RPC/hosting providers and smoke output before launch evidence is complete.");
  lines.push("- Public web hosting needs the selected manifest, built artifact checks, domain/TLS evidence, deployed smoke output, and rollback owner before #43 can close.");
  lines.push("- Live web-flow evidence needs manifest-backed pools, token metadata, swap/liquidity/position flows, and safe degraded-state handling before #46 can close.");
  lines.push("- Testnet rehearsal needs deploy, verify, promoted manifests, web, indexer, RPC, ownership, launch-health, rollback, and operator sign-off evidence before #55 can close.");
  lines.push("- RPC/replay evidence proves Blockscout archive reads and an independent QuickNode demo fallback, but durable project-owned testnet fallback/failover evidence and mainnet provider readiness remain open; Explorer shares the official RPC failure domain and is archive-only.");
  lines.push("- Mainnet ownership handoff still needs approved owner evidence during final release; observability and testnet rehearsal gates remain launch-blocking until named owners attach evidence.");
  lines.push("- Live launch health needs a promoted manifest plus RPC/indexer endpoints, so CI validates command presence but does not call production services.");

  return `${lines.join("\n")}\n`;
}

function pushStatus(lines, label, items) {
  for (const item of items) {
    lines.push(`- ${label}: ${item}`);
  }
}

const report = validate();
const ok = report.repositoryChecksOk;

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        ok,
        repositoryChecksOk: report.repositoryChecksOk,
        mainnetLaunchReady: report.mainnetLaunchReady,
        strictLaunch,
        runtimeManifests,
        errors: report.errors,
        warnings: report.warnings,
        launchBlockers: report.launchBlockers,
        runtimeManifestResults: report.runtimeManifestResults,
        reviewIssueCoverage,
        gates: gates.map(([id, issue, policy, lane, command]) => ({ id, issue, policy, lane, command }))
      },
      null,
      2
    )
  );
} else {
  console.log(toMarkdown(report));
}

if (!ok) {
  process.exitCode = 1;
}
