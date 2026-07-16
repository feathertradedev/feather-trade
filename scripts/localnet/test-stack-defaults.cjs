const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const stack = fs.readFileSync(path.join(root, "scripts/localnet/stack.sh"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

assert.doesNotMatch(
  stack,
  /MARKET_ACTIVITY_ANVIL_START_TIMESTAMP|--timestamp\b|15\s*\*\s*24\s*\*\s*60\s*\*\s*60/,
  "the default stack must let Anvil use the current wall-clock time"
);
assert.doesNotMatch(
  stack,
  /packages\/dev-market-activity\/dist\/src\/cli\.js["']?\s+seed\b/,
  "the default stack must not seed historical market activity"
);

const build = stack.indexOf("pnpm sdk:build && pnpm market-activity:build");
const canonicalSource = stack.indexOf('ANALYTICS_BLOCK_SOURCE_MODULE="$BLOCK_SOURCE_MODULE"');
const analyticsStart = stack.indexOf("--filter @robinhood-lb/analytics start");
const strictHealth = stack.indexOf("--strict --json");
const continuousStart = stack.indexOf('packages/dev-market-activity/dist/src/cli.js" start');

for (const [label, index] of [
  ["SDK and market-activity build", build],
  ["analytics canonical block source", canonicalSource],
  ["analytics service start", analyticsStart],
  ["strict stack health gate", strictHealth],
  ["continuous market activity", continuousStart]
]) {
  assert.notEqual(index, -1, `missing ${label} wiring`);
}
assert(
  build < canonicalSource && canonicalSource < analyticsStart && analyticsStart < strictHealth && strictHealth < continuousStart,
  "the stack must build, replay canonical analytics, pass strict health, and only then start continuous activity"
);

const seedCommand = packageJson.scripts?.["market-activity:seed"];
assert.equal(typeof seedCommand, "string", "the explicit market-activity:seed command must remain available");
assert.match(
  seedCommand,
  /packages\/dev-market-activity\/dist\/src\/cli\.js\s+seed\b/,
  "market-activity:seed must remain an explicit opt-in command"
);
assert.match(
  packageJson.scripts?.["market-activity:start"] ?? "",
  /packages\/dev-market-activity\/dist\/src\/cli\.js\s+start\b/,
  "the explicit continuous market-activity command must remain available"
);

console.log("Local stack defaults keep history opt-in and continuous activity health-gated.");
