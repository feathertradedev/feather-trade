import { loadMarketActivityConfig } from "./config.js";
import { seedMarketActivity, startMarketActivity } from "./runner.js";

const mode = process.argv[2];
if (mode !== "seed" && mode !== "start") throw new Error("Usage: dev-market-activity <seed|start>");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}
const config = loadMarketActivityConfig();
await (mode === "seed" ? seedMarketActivity(config, controller.signal) : startMarketActivity(config, controller.signal));
