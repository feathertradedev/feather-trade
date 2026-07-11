#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const wrapper = path.join(repoRoot, "scripts/indexer/smoke-robinhood.sh");
const localDir = path.join(repoRoot, ".local");
const outFile = path.join(localDir, "subgraph-smoke-robinhood.json");
const errorFile = path.join(localDir, "subgraph-smoke-robinhood-error.log");
const factory = "0x2222222222222222222222222222222222222222";
const pair = "0x1111111111111111111111111111111111111111";
const tokenX = "0x5555555555555555555555555555555555555555";
const tokenY = "0x6666666666666666666666666666666666666666";
const activeId = "8388608";
const blockHash = `0x${"ab".repeat(32)}`;
const rpcUrl = "https://rpc.example/archive?api-key=wrapper-secret-canary";

const success = runWrapper();
assert.equal(success.result.status, 0, success.result.stderr || success.result.stdout);
const successOutput = JSON.parse(success.result.stdout);
assert.equal(successOutput.block, 110);
assert.equal(successOutput.rpcHeadBlock, 120);
assert.equal(successOutput.rpcBlockHash, blockHash);
assert.equal(successOutput.rpcChecks[0].activeBinTotalSupply, "300");
assertPinnedQueries(success.curlLog, 110);
assertPinnedCastCalls(success.castLog, 110);

const catchUp = runWrapper({
  attempts: "2",
  extraEnv: { FAKE_META_BLOCKS: "90,110", FAKE_RPC_HEADS: "100,121" }
});
assert.equal(catchUp.result.status, 0, catchUp.result.stderr || catchUp.result.stdout);
const catchUpOutput = JSON.parse(catchUp.result.stdout);
assert.equal(catchUpOutput.block, 110);
assert.equal(catchUpOutput.rpcHeadBlock, 121, "each retry must capture a fresh RPC head");
const catchUpCastCalls = readLines(catchUp.castLog);
assert.equal(catchUpCastCalls.filter((args) => args[0] === "block-number").length, 2);

const malformedSnapshot = runWrapper({
  attempts: "2",
  extraEnv: { FAKE_MALFORMED_SNAPSHOT_FIRST: "1", FAKE_RPC_HEADS: "120,121" }
});
assert.equal(malformedSnapshot.result.status, 0, malformedSnapshot.result.stderr || malformedSnapshot.result.stdout);
assert.equal(JSON.parse(malformedSnapshot.result.stdout).rpcHeadBlock, 121);
assert.equal(
  readLines(malformedSnapshot.curlLog).filter((payload) => String(payload.query).includes("RobinhoodSnapshot")).length,
  2,
  "malformed snapshot payload should retry"
);
assert.deepEqual(readLines(malformedSnapshot.sleepLog), ["Pinned indexer snapshot response was malformed.\n"]);
assert.doesNotMatch(`${malformedSnapshot.result.stdout}\n${malformedSnapshot.result.stderr}`, /SyntaxError|JSON\.parse/);

const malformedBins = runWrapper({
  attempts: "2",
  extraEnv: { FAKE_MALFORMED_BINS_FIRST: "1", FAKE_RPC_HEADS: "120,121" }
});
assert.equal(malformedBins.result.status, 0, malformedBins.result.stderr || malformedBins.result.stdout);
assert.equal(JSON.parse(malformedBins.result.stdout).rpcHeadBlock, 121);
assert.equal(
  readLines(malformedBins.curlLog).filter((payload) => String(payload.query).includes("RobinhoodActiveBins")).length,
  2,
  "malformed active-bin payload should retry"
);
assert.deepEqual(readLines(malformedBins.sleepLog), ["Pinned active-bin response was malformed.\n"]);
assert.doesNotMatch(`${malformedBins.result.stdout}\n${malformedBins.result.stderr}`, /SyntaxError|JSON\.parse/);

const mismatch = runWrapper({ extraEnv: { FAKE_ROBINHOOD_SMOKE_BAD_BIN: "1" } });
assert.notEqual(mismatch.result.status, 0);
assert.match(`${mismatch.result.stdout}\n${mismatch.result.stderr}`, /active bin .* reserves do not match RPC getBin/i);

const secretFailure = runWrapper({ extraEnv: { FAKE_CAST_FAIL: "1" } });
assert.notEqual(secretFailure.result.status, 0);
const secretOutput = `${secretFailure.result.stdout}\n${secretFailure.result.stderr}\n${fs.readFileSync(errorFile, "utf8")}`;
assert.equal(secretOutput.includes(rpcUrl), false, "tokenized RPC URL leaked through wrapper failure");
assert.equal(secretOutput.includes("wrapper-secret-canary"), false, "RPC token canary leaked through wrapper failure");

console.log("smoke-robinhood block-consistent wrapper fixture tests passed");

function makeManifest() {
  return { startBlock: 100, endpoints: { indexerUrl: "http://subgraph.example", rpcUrl }, contracts: { lbFactory: factory } };
}

function makeResponse() {
  return {
    data: {
      _meta: { hasIndexingErrors: false, block: { number: 110, hash: blockHash } },
      factories: [{ id: factory, pairCount: "1", quoteAssetCount: "1", presetCount: "1" }],
      pairs: [{ id: pair, factory: { id: factory }, tokenX: { id: tokenX }, tokenY: { id: tokenY }, binStep: "10", activeId, reserveX: "100", reserveY: "200", swapCount: "1", depositCount: "1", withdrawCount: "1" }],
      swaps: [{ id: "swap-1", pair: { id: pair }, activeId, amountsIn: "0x01", amountInX: "1", amountInY: "0", amountsOut: "0x02", amountOutX: "0", amountOutY: "2", transactionHash: "0xswap" }],
      liquidityEvents: [
        { id: "deposit-1", pair: { id: pair }, type: "DEPOSIT", ids: [activeId], amounts: ["0x01"], amountX: "5", amountY: "6", transactionHash: "0xdeposit" },
        { id: "withdraw-1", pair: { id: pair }, type: "WITHDRAW", ids: [activeId], amounts: ["0x01"], amountX: "1", amountY: "2", transactionHash: "0xwithdraw" }
      ],
      positions: [{ id: "position-1", pair: { id: pair }, owner: "0x4444444444444444444444444444444444444444", liquidity: "300", bin: { binId: activeId } }]
    }
  };
}

function runWrapper({ attempts = "1", extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robinhood-smoke-wrapper-"));
  const binDir = path.join(dir, "bin");
  const manifestPath = writeJson(dir, "manifest.json", makeManifest());
  const castLog = path.join(dir, "cast.jsonl");
  const curlLog = path.join(dir, "curl.jsonl");
  const sleepLog = path.join(dir, "sleep.jsonl");
  fs.mkdirSync(binDir);
  writeFakeCast(binDir);
  writeFakeCurl(binDir);
  writeFakeSleep(binDir);
  for (const file of [outFile, errorFile, path.join(localDir, "subgraph-smoke-robinhood-meta.json"), path.join(localDir, "subgraph-smoke-robinhood-bins.json")]) {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  const result = childProcess.spawnSync("bash", [wrapper], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_CAST_LOG: castLog,
      FAKE_CURL_LOG: curlLog,
      FAKE_ERROR_FILE: errorFile,
      FAKE_SLEEP_LOG: sleepLog,
      FAKE_COUNTER_DIR: dir,
      INDEXER_ROBINHOOD_ENDPOINT: "http://subgraph.example",
      INDEXER_ROBINHOOD_EXPECT_PAIRS: pair,
      INDEXER_ROBINHOOD_RPC_URL: rpcUrl,
      INDEXER_ROBINHOOD_SMOKE_ATTEMPTS: attempts,
      INDEXER_ROBINHOOD_SMOKE_SLEEP_SECONDS: "0",
      ROBINHOOD_MANIFEST_PATH: manifestPath,
      ...extraEnv
    },
    timeout: 10_000
  });
  return { castLog, curlLog, sleepLog, result };
}

function writeFakeCast(binDir) {
  fs.writeFileSync(path.join(binDir, "cast"), `#!/usr/bin/env node
const fs=require("node:fs"), path=require("node:path"); const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CAST_LOG, JSON.stringify(args)+"\\n");
if(args.includes("--rpc-url")) process.exit(8);
if(process.env.FAKE_CAST_FAIL==="1"){console.error("fixture failure "+process.env.ETH_RPC_URL);process.exit(9);}
function next(name,list,fallback){const file=path.join(process.env.FAKE_COUNTER_DIR,name);let i=fs.existsSync(file)?Number(fs.readFileSync(file,"utf8")):0;fs.writeFileSync(file,String(i+1));const values=String(list||fallback).split(",");return values[Math.min(i,values.length-1)];}
if(args[0]==="block-number") console.log(next("head",process.env.FAKE_RPC_HEADS,"120"));
else if(args[0]==="block") console.log("${blockHash}");
else if(args[0]==="call"&&args[2]==="getActiveId()(uint24)") console.log("${activeId}");
else if(args[0]==="call"&&args[2]==="getReserves()(uint128,uint128)") console.log("100\\n200");
else if(args[0]==="call"&&args[2]==="getBin(uint24)(uint128,uint128)") console.log("90\\n110");
else if(args[0]==="call"&&args[2]==="totalSupply(uint256)(uint256)") console.log("300"); else process.exit(3);
`);
  fs.chmodSync(path.join(binDir, "cast"), 0o755);
}

function writeFakeCurl(binDir) {
  const response = JSON.stringify(makeResponse());
  fs.writeFileSync(path.join(binDir, "curl"), `#!/usr/bin/env node
const fs=require("node:fs"),path=require("node:path"); const args=process.argv.slice(2); const payload=JSON.parse(args[args.indexOf("--data")+1]);
fs.appendFileSync(process.env.FAKE_CURL_LOG,JSON.stringify(payload)+"\\n"); const query=String(payload.query||"");
function next(name){const file=path.join(process.env.FAKE_COUNTER_DIR,name);let i=fs.existsSync(file)?Number(fs.readFileSync(file,"utf8")):0;fs.writeFileSync(file,String(i+1));return i;}
function nextMeta(){const i=next("meta");const values=String(process.env.FAKE_META_BLOCKS||"110").split(",");return Number(values[Math.min(i,values.length-1)]);}
if(query.includes("RobinhoodMeta")){const block=nextMeta();console.log(JSON.stringify({data:{_meta:{hasIndexingErrors:false,block:{number:block,hash:"${blockHash}"}}}}));}
else if(query.includes("RobinhoodActiveBins")){
  if(process.env.FAKE_MALFORMED_BINS_FIRST==="1"&&next("bins")===0) process.stdout.write("{malformed-active-bins");
  else console.log(JSON.stringify({data:{bins:[{id:"${pair}-${activeId}",pair:{id:"${pair}"},binId:"${activeId}",reserveX:process.env.FAKE_ROBINHOOD_SMOKE_BAD_BIN==="1"?"91":"90",reserveY:"110",totalSupply:"300"}]}}));
}
else {
  if(process.env.FAKE_MALFORMED_SNAPSHOT_FIRST==="1"&&next("snapshot")===0) process.stdout.write("{malformed-snapshot");
  else { const value=${JSON.stringify(response)}; console.log(value); }
}
`);
  fs.chmodSync(path.join(binDir, "curl"), 0o755);
}

function writeFakeSleep(binDir) {
  fs.writeFileSync(path.join(binDir, "sleep"), `#!/usr/bin/env node
const fs=require("node:fs");
const message=fs.existsSync(process.env.FAKE_ERROR_FILE)?fs.readFileSync(process.env.FAKE_ERROR_FILE,"utf8"):"";
fs.appendFileSync(process.env.FAKE_SLEEP_LOG,JSON.stringify(message)+"\\n");
`);
  fs.chmodSync(path.join(binDir, "sleep"), 0o755);
}

function assertPinnedQueries(file, block) {
  const payloads = readLines(file);
  const snapshot = payloads.find((payload) => String(payload.query).includes("RobinhoodSnapshot"));
  const bins = payloads.find((payload) => String(payload.query).includes("RobinhoodActiveBins"));
  assert.equal(snapshot.variables.block, block);
  assert.equal((snapshot.query.match(/block: \{ number: \$block \}/g) || []).length, 5);
  assert.equal(bins.variables.block, block);
  assert.match(bins.query, /bins\([^)]*block: \{ number: \$block \}/);
}

function assertPinnedCastCalls(file, block) {
  const calls = readLines(file);
  assert(calls.every((args) => !args.includes("--rpc-url")));
  assert(calls.filter((args) => args[0] === "call").every((args) => args[args.indexOf("--block") + 1] === String(block)));
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); return file;
}
