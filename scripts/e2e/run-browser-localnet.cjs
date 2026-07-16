#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const artifactDir = path.resolve(process.env.E2E_BROWSER_ARTIFACT_DIR ?? path.join(root, ".local/browser-e2e"));
const manifestPath = path.join(artifactDir, "manifest.json");
const forgeManifestPath = path.join(root, "deployments/localnet", `browser-e2e-${process.pid}.json`);
const chainId = 31_337;
const wrongChainId = 46_630;
const defaultAccount = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const browserAccount = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const browserTokenFunding = "20000000000000000000";
const ownedProcesses = [];
let summary = { status: "failed", steps: [], error: undefined };

async function main() {
  ensureTools();
  fs.mkdirSync(artifactDir, { recursive: true });

  const reserved = new Set();
  const rpcPort = await selectPort("E2E_BROWSER_RPC_PORT", 19_545, reserved);
  const wrongRpcPort = await selectPort("E2E_BROWSER_WRONG_RPC_PORT", rpcPort + 1, reserved);
  const webPort = await selectPort("E2E_BROWSER_WEB_PORT", 5_276, reserved);
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const wrongRpcUrl = `http://127.0.0.1:${wrongRpcPort}`;

  try {
    startAnvil("anvil-main", rpcPort, chainId);
    startAnvil("anvil-wrong-chain", wrongRpcPort, wrongChainId);
    waitForRpc(rpcUrl, chainId);
    waitForRpc(wrongRpcUrl, wrongChainId);

    runStep(
      "deploy",
      [
        "forge",
        "script",
        "contracts/joe-v2/script/deploy-local.s.sol:LocalnetDeployScript",
        "--rpc-url",
        rpcUrl,
        "--broadcast"
      ],
      sanitizedEnvironment({
        LOCALNET_RPC_URL: rpcUrl,
        LOCALNET_MANIFEST_PATH: forgeManifestPath
      })
    );

    writeBrowserManifest(forgeManifestPath, manifestPath);

    const manifest = readManifest();
    assertManifestMatchesBrowserLocalnet(manifest);
    fundBrowserToken(rpcUrl, manifest.tokens.weth, "weth-browser-funding");
    fundBrowserToken(rpcUrl, manifest.tokens.usdc, "usdc-browser-funding");

    runStep(
      "playwright",
      [
        "pnpm",
        "--filter",
        "@robinhood-lb/web",
        "exec",
        "playwright",
        "test",
        "--config",
        "playwright.localnet.config.ts"
      ],
      sanitizedEnvironment({
        E2E_BROWSER_ARTIFACT_DIR: artifactDir,
        E2E_BROWSER_ACCOUNT: browserAccount,
        E2E_BROWSER_MANIFEST_PATH: manifestPath,
        E2E_BROWSER_RPC_URL: rpcUrl,
        E2E_BROWSER_WEB_PORT: String(webPort),
        E2E_BROWSER_WRONG_RPC_URL: wrongRpcUrl,
        VITE_LOCALNET_MANIFEST_PATH: manifestPath
      })
    );

    summary.status = "passed";
    writeSummary();
    console.log(`Browser-to-localnet E2E passed. Artifacts: ${path.relative(root, artifactDir)}`);
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    writeSummary();
    throw error;
  } finally {
    stopOwnedProcesses();
    fs.rmSync(forgeManifestPath, { force: true });
  }
}

function ensureTools() {
  for (const command of ["anvil", "cast", "forge", "pnpm"]) {
    const result = childProcess.spawnSync(command, ["--version"], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Browser localnet E2E requires ${command} on PATH`);
  }
}

function startAnvil(name, port, expectedChainId) {
  const logPath = path.join(artifactDir, `${name}.log`);
  const logFd = fs.openSync(logPath, "w");
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--chain-id",
    String(expectedChainId),
    "--base-fee",
    "0",
    "--gas-limit",
    "30000000",
    "--silent"
  ];
  assertNoPrivateKeyArguments(args);

  const process = childProcess.spawn("anvil", args, {
    cwd: root,
    env: sanitizedEnvironment(),
    stdio: ["ignore", logFd, logFd]
  });
  fs.closeSync(logFd);
  ownedProcesses.push(process);
  summary.steps.push({ name, status: "started", artifact: path.relative(root, logPath), port, chainId: expectedChainId });
}

function waitForRpc(url, expectedChainId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = childProcess.spawnSync("cast", ["chain-id", "--rpc-url", url], {
      cwd: root,
      env: sanitizedEnvironment(),
      encoding: "utf8"
    });
    if (result.status === 0 && Number(result.stdout.trim()) === expectedChainId) return;
    sleep(250);
  }
  throw new Error(`Anvil did not become ready at ${url}`);
}

function runStep(name, command, env) {
  assertNoPrivateKeyArguments(command);
  const result = childProcess.spawnSync(command[0], command.slice(1), {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const artifactPath = path.join(artifactDir, `${name}.log`);
  fs.writeFileSync(artifactPath, output);
  summary.steps.push({
    name,
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    artifact: path.relative(root, artifactPath)
  });
  if (result.status === 0) {
    console.log(`${name} passed`);
  } else {
    process.stderr.write(`${output.trim().split("\n").slice(-25).join("\n")}\n`);
    throw new Error(`${name} failed with exit code ${result.status}; see ${path.relative(root, artifactPath)}`);
  }
}

function fundBrowserToken(rpcUrl, token, artifactName) {
  runStep(
    artifactName,
    [
      "cast",
      "send",
      "--rpc-url",
      rpcUrl,
      "--from",
      defaultAccount,
      "--unlocked",
      token,
      "transfer(address,uint256)",
      browserAccount,
      browserTokenFunding
    ],
    sanitizedEnvironment()
  );
}

function readManifest() {
  if (!fs.existsSync(manifestPath)) throw new Error(`Deployment did not write ${manifestPath}`);
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function writeBrowserManifest(sourcePath, destinationPath) {
  const manifest = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  manifest.endpoints = {
    ...manifest.endpoints,
    rpcUrl: "http://127.0.0.1:8545",
    indexerUrl: "http://127.0.0.1:8000/subgraphs/name/robinhood-lb/localnet"
  };
  fs.writeFileSync(destinationPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function assertManifestMatchesBrowserLocalnet(manifest) {
  const expected = {
    chainId,
    deployer: defaultAccount,
    router: "0x0165878a594ca255338adfa4d48449f69242eb8f",
    pair: "0xbf57b75d71d91e13c97693e4e5b850b0be638dac",
    weth: "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9",
    usdc: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"
  };
  const actual = {
    chainId: manifest.chainId,
    deployer: String(manifest.deployer).toLowerCase(),
    router: String(manifest.contracts?.lbRouter).toLowerCase(),
    pair: String(manifest.seededPools?.wethUsdc?.pair).toLowerCase(),
    weth: String(manifest.tokens?.weth).toLowerCase(),
    usdc: String(manifest.tokens?.usdc).toLowerCase()
  };

  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `Browser localnet manifest mismatch for ${key}: expected ${expected[key]}, received ${actual[key]}. Add a Vite localnet manifest override before changing deterministic deployment addresses.`
      );
    }
  }
}

function assertNoPrivateKeyArguments(args) {
  const joined = args.join(" ").toLowerCase();
  if (joined.includes("private-key") || /(?:^|\s)0x[0-9a-f]{64}(?:\s|$)/.test(joined)) {
    throw new Error("Browser localnet E2E must not put a private key in process arguments");
  }
}

function sanitizedEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of ["LOCALNET_PRIVATE_KEY", "PRIVATE_KEY", "ETH_PRIVATE_KEY", "MNEMONIC"]) delete env[key];
  return env;
}

async function selectPort(environmentName, defaultPort, reserved) {
  const explicit = process.env[environmentName];
  if (explicit !== undefined) {
    const port = Number(explicit);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${environmentName} must be a valid TCP port`);
    if (reserved.has(port) || !(await portIsAvailable(port))) throw new Error(`${environmentName}=${port} is already in use`);
    reserved.add(port);
    return port;
  }

  for (let port = defaultPort; port < defaultPort + 100; port += 1) {
    if (!reserved.has(port) && (await portIsAvailable(port))) {
      reserved.add(port);
      return port;
    }
  }
  throw new Error(`Could not find an unused port starting at ${defaultPort}`);
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function stopOwnedProcesses() {
  for (const process of ownedProcesses.reverse()) {
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
  }
}

function writeSummary() {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
}

process.once("SIGINT", () => {
  stopOwnedProcesses();
  process.exitCode = 130;
});
process.once("SIGTERM", () => {
  stopOwnedProcesses();
  process.exitCode = 143;
});

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
