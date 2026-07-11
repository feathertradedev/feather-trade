#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const artifactDir = path.join(root, ".local", "e2e");
const keepAlive = process.env.E2E_LOCALNET_KEEPALIVE === "true";
const reuseExisting = process.env.E2E_LOCALNET_REUSE_EXISTING === "true";
const requestedRpcUrl = process.env.E2E_LOCALNET_RPC_URL ?? process.env.LOCALNET_RPC_URL ?? "http://127.0.0.1:18545";
const requestedRpcUrlExplicit = process.env.E2E_LOCALNET_RPC_URL !== undefined || process.env.LOCALNET_RPC_URL !== undefined;
let rpcUrl = requestedRpcUrl;
const anvilHost = process.env.E2E_LOCALNET_ANVIL_HOST ?? "127.0.0.1";
let anvilPort = process.env.E2E_LOCALNET_ANVIL_PORT ?? portFromRpcUrl(rpcUrl);
const chainId = process.env.LOCALNET_CHAIN_ID ?? "31337";
const commands = [
  { name: "swap", command: ["pnpm", "--silent", "sdk:example:localnet:swap"], expectation: "success" },
  { name: "liquidity", command: ["pnpm", "--silent", "sdk:example:localnet:liquidity"], expectation: "success" },
  { name: "expected-revert", command: ["pnpm", "--silent", "sdk:e2e:localnet:expected-revert"], expectation: "expected-revert" }
];
let anvilProcess = null;

function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  ensureAnvil();

  try {
    resetAnvil();
    setNextBlockBaseFeeToZero();
    const summary = [];

    const deployResult = run("localnet-deploy", ["pnpm", "--silent", "localnet:deploy"], { allowFailure: true });
    const deployEntry = summaryEntry("localnet-deploy", deployResult, "success");
    if (deployResult.exitCode !== 0) {
      deployEntry.status = "failed";
      deployEntry.errorSnippet = outputSnippet(deployResult.output);
      summary.push(deployEntry);
      writeSummary("failed", summary, `localnet deploy failed with exit code ${deployResult.exitCode}`);
      throw new Error("pnpm --silent localnet:deploy failed; see .local/e2e/localnet-deploy.log");
    }
    summary.push(deployEntry);

    for (const { name, command, expectation, env } of commands) {
      const result = run(name, command, { allowFailure: true, env });
      const parsed = parseJsonOutput(result.output);
      const entry = summaryEntry(name, result, expectation, parsed);

      if (expectation === "expected-revert") {
        const expectedFailureIsProven =
          result.exitCode !== 0 &&
          result.signal === null &&
          result.spawnError === null &&
          parsed?.expectedError === "LBRouter__DeadlineExceeded" &&
          parsed?.broadcastAttempted === false &&
          parsed?.nonceBefore !== undefined &&
          parsed?.nonceBefore === parsed?.nonceAfter &&
          parsed?.revertHash === undefined &&
          parsed?.transactionHash === undefined;

        if (!expectedFailureIsProven) {
          entry.status = "failed";
          entry.errorSnippet = entry.errorSnippet ?? outputSnippet(result.output);
          summary.push(entry);
          writeSummary(
            "failed",
            summary,
            `${name} must exit nonzero with LBRouter__DeadlineExceeded, no broadcast hash, and an unchanged account nonce`
          );
          throw new Error(
            `${name} did not prove a blocked broadcast after LBRouter__DeadlineExceeded; see .local/e2e/${name}.log`
          );
        }

        summary.push(entry);
        continue;
      }

      if (result.exitCode !== 0) {
        entry.status = "failed";
        entry.errorSnippet = entry.errorSnippet ?? outputSnippet(result.output);
        summary.push(entry);
        writeSummary("failed", summary, `${command.join(" ")} failed with exit code ${result.exitCode}`);
        throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}; see .local/e2e/${name}.log`);
      }

      summary.push(entry);
    }

    const summaryPath = writeSummary("passed", summary);
    console.log(`Localnet transaction E2E passed. Summary: ${path.relative(root, summaryPath)}`);
  } finally {
    stopOwnedAnvil();
  }
}

function ensureAnvil() {
  if (rpcResponds()) {
    if (reuseExisting) {
      console.log(`Using explicitly reused Anvil RPC at ${rpcUrl}`);
      return;
    }

    if (requestedRpcUrlExplicit) {
      throw new Error(
        `Refusing to reset existing RPC at ${rpcUrl}. Choose an unused E2E_LOCALNET_RPC_URL or set E2E_LOCALNET_REUSE_EXISTING=true to opt in.`
      );
    }

    const isolatedPort = findUnusedRpcPort(Number(anvilPort) + 1);
    console.log(`Existing RPC detected at ${rpcUrl}; using isolated E2E Anvil at http://127.0.0.1:${isolatedPort}`);
    rpcUrl = `http://127.0.0.1:${isolatedPort}`;
    anvilPort = String(isolatedPort);
  }

  const logPath = path.join(artifactDir, "anvil.log");
  const logFd = fs.openSync(logPath, "a");
  const args = [
    "--host",
    anvilHost,
    "--port",
    String(anvilPort),
    "--chain-id",
    chainId,
    "--base-fee",
    "0",
    "--gas-limit",
    "30000000"
  ];

  console.log(`Starting isolated Anvil for E2E at ${rpcUrl}`);
  anvilProcess = childProcess.spawn("anvil", args, {
    cwd: root,
    detached: false,
    stdio: ["ignore", logFd, logFd]
  });
  anvilProcess.unref();
  fs.closeSync(logFd);

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (rpcResponds()) return;
    sleep(250);
  }

  throw new Error(`Anvil did not become ready at ${rpcUrl}; see ${path.relative(root, logPath)}`);
}

function resetAnvil() {
  if (process.env.E2E_LOCALNET_RESET === "false") return;

  const reset = childProcess.spawnSync("cast", ["rpc", "--rpc-url", rpcUrl, "anvil_reset"], {
    cwd: root,
    encoding: "utf8"
  });
  const output = `${reset.stdout}${reset.stderr}`;
  writeArtifact("localnet-reset.log", output);
  if (reset.status === 0) {
    console.log(`Reset Anvil chain at ${rpcUrl}`);
    return;
  }

  throw new Error(`RPC at ${rpcUrl} did not accept anvil_reset; this E2E runner requires Anvil. See .local/e2e/localnet-reset.log`);
}

function setNextBlockBaseFeeToZero() {
  const result = childProcess.spawnSync("cast", ["rpc", "--rpc-url", rpcUrl, "anvil_setNextBlockBaseFeePerGas", "0x0"], {
    cwd: root,
    encoding: "utf8"
  });
  const output = `${result.stdout}${result.stderr}`;
  writeArtifact("localnet-base-fee.log", output);
  if (result.status !== 0) {
    throw new Error(`Failed to set Anvil next block base fee at ${rpcUrl}; see .local/e2e/localnet-base-fee.log`);
  }
}

function run(name, command, options = {}) {
  console.log(`\n==> ${command.join(" ")}`);
  const result = childProcess.spawnSync(command[0], command.slice(1), {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      LOCALNET_RPC_URL: rpcUrl,
      SDK_EXAMPLE_DEADLINE_MINUTES: process.env.SDK_EXAMPLE_DEADLINE_MINUTES ?? "20",
      SDK_EXAMPLE_ID_SLIPPAGE: process.env.SDK_EXAMPLE_ID_SLIPPAGE ?? "2",
      SDK_EXAMPLE_SLIPPAGE_BPS: process.env.SDK_EXAMPLE_SLIPPAGE_BPS ?? "50",
      ...options.env
    }
  });
  const spawnError = result.error ? result.error.message : null;
  const signal = result.signal ?? null;
  const exitCode = result.status === null ? 1 : result.status;
  const processFailure =
    result.status === null
      ? `Child process did not exit normally${signal ? `; signal=${signal}` : ""}${spawnError ? `; error=${spawnError}` : ""}\n`
      : "";
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${processFailure}`;
  const artifact = writeArtifact(`${name}.log`, output);

  if (output.trim().length > 0) process.stdout.write(output);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${exitCode}${signal ? ` (${signal})` : ""}; see .local/e2e/${name}.log`
    );
  }

  return {
    output,
    exitCode,
    signal,
    spawnError,
    artifact
  };
}

function parseJsonOutput(output) {
  const trimmed = output.trim();
  if (trimmed.length === 0) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;

    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function summaryEntry(name, result, expectation, parsed = null) {
  return {
    name,
    artifact: path.relative(root, result.artifact),
    exitCode: result.exitCode,
    signal: result.signal,
    spawnError: result.spawnError,
    status: expectation === "expected-revert" ? "failed-simulation-blocked-broadcast" : "passed",
    expectedError: parsed?.expectedError,
    errorSnippet: parsed?.simulationError?.message,
    broadcastAttempted: parsed?.broadcastAttempted,
    nonceBefore: parsed?.nonceBefore,
    nonceAfter: parsed?.nonceAfter
  };
}

function writeSummary(status, commands, error) {
  return writeArtifact("summary.json", `${JSON.stringify({ status, commands, error }, null, 2)}\n`);
}

function outputSnippet(output) {
  return output.trim().split("\n").slice(0, 12).join("\n");
}

function stopOwnedAnvil() {
  if (!anvilProcess || keepAlive) return;
  if (anvilProcess.exitCode !== null) return;

  console.log(`Stopping isolated Anvil process ${anvilProcess.pid}`);
  anvilProcess.kill("SIGTERM");
}

function rpcResponds() {
  return rpcRespondsAt(rpcUrl);
}

function rpcRespondsAt(url) {
  const result = childProcess.spawnSync("cast", ["chain-id", "--rpc-url", url], {
    cwd: root,
    env: process.env,
    encoding: "utf8"
  });
  return result.status === 0;
}

function findUnusedRpcPort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (!rpcRespondsAt(`http://127.0.0.1:${port}`)) return port;
  }

  throw new Error(`Could not find an unused local E2E RPC port starting at ${startPort}`);
}

function sleep(milliseconds) {
  childProcess.spawnSync("sleep", [String(milliseconds / 1000)]);
}

function portFromRpcUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port.length > 0) return parsed.port;
  } catch {
    return "18545";
  }
  return "18545";
}

function writeArtifact(name, contents) {
  const filePath = path.join(artifactDir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
