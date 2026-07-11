#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const composePath = "infra/graph-node/docker-compose.robinhood.example.yml";
const localComposePath = "indexer/subgraph/docker-compose.yml";
const envPath = "infra/graph-node/.env.example";
const readmePath = "infra/graph-node/README.md";
const localReadmePath = "indexer/subgraph/README.md";
const runbookPath = "docs/wave-2/self-hosted-graph-node-runbook.md";
const subgraphPath = "docs/wave-2/robinhood-subgraph-deployment.md";
const graphNodeImage = "graphprotocol/graph-node:v0.44.0@sha256:c14c6d8e2b2b1ed89f6a89babf48d807b18a43e372fda7fb495d3a9050b65b8b";
const ipfsImage = "ipfs/kubo:v0.29.0@sha256:53236eaeb876c6d837ee7b04a9b0e737a22e5f4471d0f99fb499fba28034aa61";
const postgresImage = "postgres:16.13-alpine@sha256:4e6e670bb069649261c9c18031f0aded7bb249a5b6664ddec29c013a89310d50";
const jsonMode = process.argv.includes("--json");

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function parseEnv(text) {
  const result = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) {
      throw new Error(`${envPath}:${index + 1}: expected KEY=value`);
    }

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function runDockerComposeConfig(targetComposePath, targetEnvPath = null) {
  const args = ["compose", "-f", targetComposePath];
  if (targetEnvPath) args.push("--env-file", targetEnvPath);
  args.push("config", "--format", "json");
  const result = childProcess.spawnSync(
    "docker",
    args,
    { cwd: root, encoding: "utf8" }
  );

  if (result.error) {
    throw new Error(`failed to run docker compose: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new Error(output || `docker compose config failed for ${targetComposePath}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`docker compose config did not return JSON: ${error.message}`);
  }
}

function sortedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

function hasToken(text, token) {
  return text.toLowerCase().includes(token.toLowerCase());
}

function validate() {
  const errors = [];
  const warnings = [];

  function assert(condition, message) {
    if (!condition) errors.push(message);
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      errors.push(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  let config = null;
  let localConfig = null;
  try {
    config = runDockerComposeConfig(composePath, envPath);
  } catch (error) {
    errors.push(error.message);
  }
  try {
    localConfig = runDockerComposeConfig(localComposePath);
  } catch (error) {
    errors.push(error.message);
  }

  const rawCompose = readText(composePath);
  const env = parseEnv(readText(envPath));
  const readme = readText(readmePath);
  const localReadme = readText(localReadmePath);
  const runbook = readText(runbookPath);
  const subgraphDeployment = readText(subgraphPath);

  if (config) {
    const services = config.services ?? {};
    assertEqual(
      JSON.stringify(sortedKeys(services)),
      JSON.stringify(["graph-node", "ipfs", "postgres"]),
      "compose services must be exactly graph-node, ipfs, and postgres"
    );

    const graphNode = services["graph-node"] ?? {};
    const ipfs = services.ipfs ?? {};
    const postgres = services.postgres ?? {};

    assertEqual(graphNode.image, graphNodeImage, "graph-node service image must remain version-and-digest pinned");
    assertEqual(ipfs.image, ipfsImage, "ipfs service image must remain version-and-digest pinned");
    assertEqual(postgres.image, postgresImage, "postgres service image must remain patch-and-digest pinned");

    const graphDeps = Array.isArray(graphNode.depends_on)
      ? graphNode.depends_on
      : Object.keys(graphNode.depends_on ?? {});
    assert(graphDeps.includes("ipfs"), "graph-node must depend on ipfs");
    assert(graphDeps.includes("postgres"), "graph-node must depend on postgres");

    const graphPorts = graphNode.ports ?? [];
    assertEqual(graphPorts.length, 1, "graph-node must publish exactly one port");
    if (graphPorts[0]) {
      assertEqual(graphPorts[0].host_ip, "127.0.0.1", "graph-node GraphQL port must bind to loopback");
      assertEqual(Number(graphPorts[0].target), 8000, "graph-node published target must be GraphQL port 8000");
      assertEqual(String(graphPorts[0].published), env.GRAPH_NODE_GRAPHQL_PORT, "graph-node published port must come from GRAPH_NODE_GRAPHQL_PORT");
    }

    for (const serviceName of ["ipfs", "postgres"]) {
      assert(
        !Array.isArray(services[serviceName]?.ports) || services[serviceName].ports.length === 0,
        `${serviceName} must not publish host ports`
      );
    }

    for (const [serviceName, service] of Object.entries(services)) {
      assert(service.network_mode !== "host", `${serviceName} must not use host networking`);
      assert(service.privileged !== true, `${serviceName} must not run privileged`);

      for (const port of service.ports ?? []) {
        const target = Number(port.target);
        const published = Number(port.published);
        for (const forbiddenPort of [8020, 8030, 8040, 5001, 5432, 8080]) {
          assert(target !== forbiddenPort, `${serviceName} must not publish target port ${forbiddenPort}`);
          assert(published !== forbiddenPort, `${serviceName} must not publish host port ${forbiddenPort}`);
        }
      }
    }

    const graphEnv = graphNode.environment ?? {};
    assertEqual(graphEnv.postgres_host, "postgres", "graph-node postgres_host must target the postgres service");
    assertEqual(graphEnv.postgres_user, "graph-node", "graph-node postgres_user must match the example database user");
    assertEqual(graphEnv.postgres_db, "graph-node", "graph-node postgres_db must match the example database");
    assertEqual(graphEnv.postgres_pass, env.GRAPH_NODE_POSTGRES_PASSWORD, "graph-node postgres_pass must come from GRAPH_NODE_POSTGRES_PASSWORD");
    assertEqual(graphEnv.ipfs, "ipfs:5001", "graph-node ipfs endpoint must stay on the private compose network");
    assertEqual(
      graphEnv.ethereum,
      `${env.GRAPH_NODE_NETWORK}:${env.GRAPH_NODE_ARCHIVE_RPC_URL}`,
      "graph-node ethereum provider must come from GRAPH_NODE_NETWORK and GRAPH_NODE_ARCHIVE_RPC_URL"
    );
    assertEqual(graphEnv.GRAPH_LOG, env.GRAPH_LOG, "GRAPH_LOG must come from .env.example");

    const postgresEnv = postgres.environment ?? {};
    assertEqual(postgresEnv.POSTGRES_USER, "graph-node", "Postgres user must be graph-node");
    assertEqual(postgresEnv.POSTGRES_PASSWORD, env.GRAPH_NODE_POSTGRES_PASSWORD, "Postgres password must come from GRAPH_NODE_POSTGRES_PASSWORD");
    assertEqual(postgresEnv.POSTGRES_DB, "graph-node", "Postgres database must be graph-node");
    assertEqual(postgresEnv.POSTGRES_INITDB_ARGS, "--locale=C --encoding=UTF8", "Postgres must initialize with C locale and UTF8 encoding");

    const postgresCommand = Array.isArray(postgres.command) ? postgres.command.join(" ") : String(postgres.command ?? "");
    for (const token of ["pg_stat_statements", "shared_buffers", "work_mem", "maintenance_work_mem"]) {
      assert(postgresCommand.includes(token), `Postgres command missing ${token}`);
    }

    const volumes = sortedKeys(config.volumes ?? {});
    assert(volumes.includes("ipfs-data"), "compose must declare ipfs-data volume");
    assert(volumes.includes("postgres-data"), "compose must declare postgres-data volume");
    assert(
      (ipfs.volumes ?? []).some((volume) => volume.target === "/data/ipfs"),
      "ipfs service must persist /data/ipfs"
    );
    assert(
      (postgres.volumes ?? []).some((volume) => volume.target === "/var/lib/postgresql/data"),
      "postgres service must persist /var/lib/postgresql/data"
    );
  }

  if (localConfig) {
    const localServices = localConfig.services ?? {};
    assertEqual(
      JSON.stringify(sortedKeys(localServices)),
      JSON.stringify(["graph-node", "ipfs", "postgres"]),
      "local compose services must be exactly graph-node, ipfs, and postgres"
    );
    for (const [serviceName, expectedImage] of [
      ["graph-node", graphNodeImage],
      ["ipfs", ipfsImage],
      ["postgres", postgresImage]
    ]) {
      assertEqual(localServices[serviceName]?.image, expectedImage, `${localComposePath} ${serviceName} image must remain immutable`);
      if (config) {
        assertEqual(
          localServices[serviceName]?.image,
          config.services?.[serviceName]?.image,
          `${serviceName} image must be identical in local and self-hosted compose stacks`
        );
      }
    }
  }

  for (const token of [
    "${GRAPH_NODE_NETWORK:?set GRAPH_NODE_NETWORK}",
    "${GRAPH_NODE_ARCHIVE_RPC_URL:?set GRAPH_NODE_ARCHIVE_RPC_URL}",
    "${GRAPH_NODE_POSTGRES_PASSWORD:?set GRAPH_NODE_POSTGRES_PASSWORD}",
    "127.0.0.1:${GRAPH_NODE_GRAPHQL_PORT:-8000}:8000"
  ]) {
    assert(rawCompose.includes(token), `${composePath} missing fail-fast/private interpolation token: ${token}`);
  }

  for (const key of [
    "GRAPH_NODE_NETWORK",
    "GRAPH_NODE_ARCHIVE_RPC_URL",
    "INDEXER_ROBINHOOD_RPC_URL",
    "GRAPH_NODE_POSTGRES_PASSWORD",
    "GRAPH_NODE_GRAPHQL_PORT",
    "GRAPH_LOG",
    "POSTGRES_SHARED_BUFFERS",
    "POSTGRES_WORK_MEM",
    "POSTGRES_MAINTENANCE_WORK_MEM"
  ]) {
    assert(Object.prototype.hasOwnProperty.call(env, key), `${envPath} missing ${key}`);
  }

  assert(["robinhood-testnet", "robinhood-mainnet"].includes(env.GRAPH_NODE_NETWORK), `${envPath} must use a Robinhood Graph network name`);
  assertEqual(env.GRAPH_NODE_ARCHIVE_RPC_URL, "https://archive-rpc.example.invalid", `${envPath} archive RPC must be a non-secret placeholder`);
  assertEqual(env.INDEXER_ROBINHOOD_RPC_URL, "https://archive-rpc.example.invalid", `${envPath} smoke RPC must be a non-secret placeholder`);
  assertEqual(env.GRAPH_NODE_POSTGRES_PASSWORD, "replace-with-secret", `${envPath} Postgres password must be a placeholder`);
  assertEqual(env.GRAPH_NODE_GRAPHQL_PORT, "8000", `${envPath} GraphQL port default must be 8000`);
  assertEqual(env.GRAPH_LOG, "info", `${envPath} GRAPH_LOG default must be info`);

  for (const [key, value] of Object.entries(env)) {
    if (/^https?:\/\//.test(value) && !value.includes("example.invalid")) {
      errors.push(`${envPath} ${key} must not contain a live URL`);
    }
  }

  for (const [pathLabel, text, tokens] of [
    [
      runbookPath,
      runbook,
      [
        "pnpm graph-node:validate",
        "loopback",
        "admin",
        "status",
        "IPFS",
        "Postgres",
        "Archive RPC",
        "Deploy Or Reindex",
        "Backup And Restore",
        "Rollback",
        "Monitoring",
        "Cost Model",
        "Blockers",
        "pnpm indexer:smoke:robinhood"
      ]
    ],
    [
      readmePath,
      readme,
      ["pnpm graph-node:validate", "GraphQL", "loopback", "admin", "status", "IPFS", "Postgres", "Self-Hosted Graph Node Runbook"]
    ],
    [
      subgraphPath,
      subgraphDeployment,
      ["Goldsky Subgraphs as the first public", "self-hosted Graph Node as fallback", "robinhood-testnet", "robinhood-mainnet", "pnpm graph-node:validate"]
    ]
  ]) {
    for (const token of tokens) {
      assert(hasToken(text, token), `${pathLabel} missing required #37 evidence: ${token}`);
    }
  }

  for (const [pathLabel, text] of [
    [readmePath, readme],
    [localReadmePath, localReadme],
    [runbookPath, runbook]
  ]) {
    for (const image of [graphNodeImage, ipfsImage, postgresImage]) {
      assert(text.includes(image), `${pathLabel} must document immutable image ${image}`);
    }
  }

  if (errors.length === 0 && !rawCompose.includes("GRAPH_ETHEREUM_MAX_BLOCK_RANGE_SIZE")) {
    warnings.push("compose does not tune GRAPH_ETHEREUM_MAX_BLOCK_RANGE_SIZE; add it later if the selected indexer RPC needs smaller ranges");
  }

  return { ok: errors.length === 0, errors, warnings };
}

const report = validate();

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.ok) {
  console.log("Self-hosted Graph Node compose validation passed.");
  for (const warning of report.warnings) {
    console.log(`Warning: ${warning}`);
  }
} else {
  console.error("Self-hosted Graph Node compose validation failed:");
  for (const error of report.errors) {
    console.error(`- ${error}`);
  }
  for (const warning of report.warnings) {
    console.error(`Warning: ${warning}`);
  }
}

if (!report.ok) {
  process.exitCode = 1;
}
