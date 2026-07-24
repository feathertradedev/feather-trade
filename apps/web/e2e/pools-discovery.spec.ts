import { expect, test, type Page } from "./fixtures/test";

import {
  LOCALNET_ANALYTICS_URL,
  USDC,
  WNATIVE,
  WNATIVE_USDC_PAIR,
  installMockRpc
} from "./fixtures/mock-rpc";
import { LOCALNET_CHAIN_ID, installMockWallet } from "./fixtures/mock-wallet";

interface DiscoveryMockOptions {
  failTransport?: boolean;
  missingMarketCap?: boolean;
}

async function installMockPoolDiscovery(page: Page, options: DiscoveryMockOptions = {}) {
  await page.route(LOCALNET_ANALYTICS_URL, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = JSON.parse(request.postData() ?? "{}") as {
      query?: string;
      variables?: { pools?: { pair?: string; preferredQuoteToken?: string | null }[] };
    };
    if (!body.query?.includes("WebPoolDiscovery")) {
      await route.fallback();
      return;
    }
    if (options.failTransport) {
      await route.fulfill({ body: "analytics unavailable", status: 503 });
      return;
    }

    const requests = body.variables?.pools ?? [];
    const pattern = [0n, 3n, 1n, 5n, 4n, 8n, 6n, 9n, 7n, 11n, 8n, 13n, 12n, 16n, 14n, 18n, 17n, 20n, 18n, 22n, 21n, 25n, 23n, 27n];
    const start = 1_720_000_800;
    const rows = requests.map((requested, rowIndex) => {
      const pair = requested.pair!.toLowerCase();
      const quote = (requested.preferredQuoteToken ?? USDC).toLowerCase();
      const tokenX = WNATIVE.toLowerCase();
      const tokenY = USDC.toLowerCase();
      const base = quote === tokenX ? tokenY : tokenX;
      const blockHash = `0x${(400 + rowIndex).toString(16).padStart(64, "0")}`;
      return {
        pair,
        chainId: LOCALNET_CHAIN_ID,
        tokenX,
        tokenY,
        displayBaseToken: base,
        displayQuoteToken: quote,
        poolPriceQuotePerBaseE18: String((160n + BigInt(rowIndex) * 4n) * 10n ** 18n),
        hourlyCloses: pattern.map((offset, index) => ({
          startTimestamp: start + index * 3_600,
          closeUsdE18: String((160n + offset + BigInt(rowIndex) * 2n) * 10n ** 18n),
          quoteToken: quote,
          finalized: index < pattern.length - 1,
          revision: index + 1,
          priceSource: "active-bin-quote-usd",
          firstBlockHash: `0x${(500 + rowIndex * 100 + index).toString(16).padStart(64, "0")}`,
          lastBlockHash: `0x${(500 + rowIndex * 100 + index).toString(16).padStart(64, "0")}`
        })),
        priceChange24hE18: rowIndex === 0 ? "50000000000000000" : "-25000000000000000",
        tvlUsdE18: String((500_000n - BigInt(rowIndex) * 50_000n) * 10n ** 18n),
        lpNetSwapFees24hUsdE18: String((240n - BigInt(rowIndex) * 40n) * 10n ** 18n),
        volume24hUsdE18: String((120_000n - BigInt(rowIndex) * 20_000n) * 10n ** 18n),
        status: "READY",
        missingPriceTokens: [],
        asOfBlock: "42",
        asOfBlockHash: blockHash,
        asOfTimestamp: start + 24 * 3_600,
        marketMetadata: {
          marketCapUsdE18: options.missingMarketCap && rowIndex === 0
            ? null
            : String((12_345_000n - BigInt(rowIndex) * 1_000_000n) * 10n ** 18n),
          source: "dex-screener",
          fetchedAt: start + 24 * 3_600,
          logoPath: `/token-images/${"a".repeat(64)}`,
          logoSource: "dex-screener"
        }
      };
    });
    await route.fulfill({
      body: JSON.stringify({ data: { poolDiscovery: rows } }),
      contentType: "application/json",
      status: 200
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime("2026-07-12T14:00:00Z");
  await installMockRpc(page, { includePairs: true, poolCount: 2 });
  await installMockPoolDiscovery(page);
  await installMockWallet(page, { chainId: LOCALNET_CHAIN_ID });
});

test("renders the canonical pool market columns without legacy clutter", async ({ page }) => {
  await page.goto("/#/pools");
  const table = page.getByTestId("pools-market-table");
  await expect(table).toBeVisible();
  for (const header of ["Pair", "24h price trend", "Market cap", "Pool price", "TVL", "24h LP fees", "24h volume"]) {
    await expect(table.getByRole("columnheader", { name: new RegExp(header, "i") })).toBeVisible();
  }
  await expect(page.getByTestId("pool-discovery-row")).toHaveCount(2);
  await expect(table).not.toContainText("Active TVL");
  await expect(table).not.toContainText("Age");
  await expect(table).not.toContainText("Zap");
  await expect(table).not.toContainText("Action");
  await expect(table).not.toContainText("Open pool");
  await expect(table).not.toContainText("READY");
  await expect(table).not.toContainText("chain 31337");
  await expect(table.locator(".pool-token-mark img").first()).toHaveAttribute("src", /\/token-assets\/wnative\.svg$/);
  await expect(table.locator(".pool-sparkline").first()).toBeVisible();
  await expect(table.getByText("USDC per WNATIVE").first()).toBeVisible();
});

test("sortable headers are keyboard operable and persist direction in the URL", async ({ page }) => {
  await page.goto("/#/pools");
  const volumeHeader = page.getByRole("columnheader", { name: /24h volume/i });
  await expect(volumeHeader).toHaveAttribute("aria-sort", "descending");

  const marketCapSort = page.getByRole("button", { name: /Sort by Market cap/i });
  await marketCapSort.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/pools\?sort=marketCap$/);
  await expect(page.getByRole("columnheader", { name: /Market cap/i })).toHaveAttribute("aria-sort", "descending");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/sort=marketCap&direction=asc/);
  await expect(page.getByRole("columnheader", { name: /Market cap/i })).toHaveAttribute("aria-sort", "ascending");
});

test("minimum filters persist in the URL and unknown values degrade quietly", async ({ page }) => {
  await page.goto("/#/pools");
  await page.getByText("Filters", { exact: true }).click();
  await page.getByLabel("Minimum TVL in USD").fill("600000");
  await expect(page).toHaveURL(/minTvl=600000/);
  await expect(page.getByText("No pools match these filters.")).toBeVisible();

  await page.getByLabel("Minimum TVL in USD").fill("400000");
  await expect(page.getByTestId("pool-discovery-row")).toHaveCount(2);
  await page.getByLabel("Minimum 24 hour volume in USD").fill("110000");
  await expect(page).toHaveURL(/minVolume=110000/);
  await expect(page.getByTestId("pool-discovery-row")).toHaveCount(1);
  await expect(page.getByTestId("pool-discovery-warning")).toHaveCount(0);
});

test("pair navigation preserves the discovery context", async ({ page }) => {
  await page.goto("/#/pools?sort=tvl&direction=asc&minTvl=1000");
  const pair = page.getByRole("link", { name: /Open WNATIVE \/ USDC pool/i }).first();
  await expect(pair).toHaveAttribute("href", /#\/pools\/.+\?sort=tvl&direction=asc&minTvl=1000/);
  await pair.click();
  await expect(page).toHaveURL(/#\/pools\/.+/);
});

test("canonical discovery survives reload and removes an orphaned catalog entry", async ({ page }) => {
  const rpc = await installMockRpc(page, { includePairs: true, poolCount: 1 });
  const route = `/#/pools/${WNATIVE_USDC_PAIR}`;
  await page.goto(route);
  await expect(page.getByTestId("canonical-pool-workspace")).toHaveAttribute(
    "data-pool-id",
    WNATIVE_USDC_PAIR.toLowerCase()
  );

  await page.reload();
  await expect(page.getByTestId("canonical-pool-workspace")).toHaveAttribute(
    "data-pool-id",
    WNATIVE_USDC_PAIR.toLowerCase()
  );
  await expect(page.getByText(/Pool discovery is not online yet/i)).toHaveCount(0);

  rpc.update({ includePairs: false, pairByIdMode: "missing" });
  await page.reload();
  await expect(page.getByTestId("requested-pool-state")).toContainText("The requested pool was not found.");
  await expect(page.getByTestId("canonical-pool-workspace")).toHaveCount(0);
});

test("missing market cap is isolated and announced without a page warning", async ({ page }) => {
  await page.unroute(LOCALNET_ANALYTICS_URL);
  await installMockRpc(page, { includePairs: true });
  await installMockPoolDiscovery(page, { missingMarketCap: true });
  await page.goto("/#/pools");
  const marketCap = page.getByTestId("pool-market-cap").first();
  const unavailable = marketCap.getByLabel("Market cap unavailable");
  await expect(unavailable).toHaveText("-");
  await expect(unavailable).toHaveAttribute("title", /exact token metadata match/i);
  await expect(page.getByTestId("pool-discovery-warning")).toHaveCount(0);
});

test("transport-wide analytics failure uses one concise warning", async ({ page }) => {
  await page.unroute(LOCALNET_ANALYTICS_URL);
  await installMockRpc(page, { includePairs: true });
  await installMockPoolDiscovery(page, { failTransport: true });
  await page.goto("/#/pools");
  const warning = page.getByTestId("pool-discovery-warning");
  await expect(warning).toHaveText("Market analytics could not load. Pool links remain available.");
  await expect(warning).not.toContainText("503");
  await expect(warning).not.toContainText("Failed to fetch");
  await expect(page.getByTestId("pool-discovery-row")).toHaveCount(1);
});

test("320px layout keeps pair, trend, and metric grid inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/#/pools");
  await expect(page.getByTestId("pools-market-table")).toBeVisible();
  await expect(page.locator(".pool-mobile-label").filter({ hasText: "Market cap" }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const rowColumns = await page.getByTestId("pool-discovery-row").first().evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  expect(rowColumns).toBe(2);
});
