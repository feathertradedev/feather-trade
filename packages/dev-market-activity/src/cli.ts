import { loadMarketActivityConfig } from "./config.js";
import { seedMarketActivity, startMarketActivity, verifyMarketActivityMovement } from "./runner.js";

const mode = process.argv[2];
if (mode !== "seed" && mode !== "start" && mode !== "verify") throw new Error("Usage: dev-market-activity <seed|start|verify>");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort());
}
const config = loadMarketActivityConfig();
if (mode === "seed") await seedMarketActivity(config, controller.signal);
else if (mode === "start") await startMarketActivity(config, controller.signal);
else await verifyMarketActivityMovement(config, { signal: controller.signal });
