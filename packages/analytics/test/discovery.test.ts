import assert from "node:assert/strict";
import test from "node:test";

import {
  AnalyticsApiService,
  AnalyticsEngine,
  DexScreenerMarketMetadataProvider,
  USD_SCALE,
  decimalUsdToE18,
  marketMetadataLookupKey,
  sanitizeDexScreenerImageUrl,
  startAnalyticsHttpServer,
  type AnalyticsEvent,
  type BlockEnvelope,
  type MarketMetadataProvider,
  type PoolDiscoveryMarketMetadata,
  type PricePolicy,
  type ProxiedTokenImage,
  type SwapAnalyticsEvent
} from "../src/index.js";

const PAIR = "0x00000000000000000000000000000000000000a1";
const OTHER_PAIR = "0x00000000000000000000000000000000000000a2";
const TOKEN_X = "0x0000000000000000000000000000000000000011";
const TOKEN_Y = "0x0000000000000000000000000000000000000022";
const TOKEN_Z = "0x0000000000000000000000000000000000000033";
const UNIT = 10n ** 18n;

const policies: PricePolicy[] = [
  { token: TOKEN_X, source: "fixed-test", feedId: "x-usd", maxAgeSeconds: 200_000, maxConfidenceBps: 100 },
  { token: TOKEN_Y, source: "fixed-test", feedId: "y-usd", maxAgeSeconds: 200_000, maxConfidenceBps: 100 }
];

test("pool discovery is bounded, validates canonical unique requests, and omits unknown pools", () => {
  const engine = seededEngine();
  assert.throws(() => engine.queryPoolDiscovery({ pools: [] }), /between 1 and 100/);
  assert.throws(
    () => engine.queryPoolDiscovery({ pools: Array.from({ length: 101 }, (_, index) => ({
      pair: `0x${index.toString(16).padStart(40, "0")}`
    })) }),
    /between 1 and 100/
  );
  assert.throws(() => engine.queryPoolDiscovery({ pools: [{ pair: "not-an-address" }] }), /canonical EVM address/);
  assert.throws(
    () => engine.queryPoolDiscovery({ pools: [{ pair: PAIR, preferredQuoteToken: "not-an-address" }] }),
    /canonical EVM address/
  );
  assert.throws(
    () => engine.queryPoolDiscovery({ pools: [{ pair: PAIR }, { pair: PAIR.toUpperCase().replace("0X", "0x") }] }),
    /must be unique/
  );
  assert.deepEqual(engine.queryPoolDiscovery({ pools: [{ pair: OTHER_PAIR }] }), []);
});

test("pool discovery uses canonical 24-hour closes, candle orientation, signed change, and metrics", () => {
  const engine = seededEngine();
  const [row] = engine.queryPoolDiscovery({ pools: [{ pair: PAIR, preferredQuoteToken: TOKEN_X }] });
  assert(row);
  assert.equal(row.chainId, 4663);
  assert.equal(row.displayBaseToken, TOKEN_X);
  assert.equal(row.displayQuoteToken, TOKEN_Y, "canonical candle quote orientation wins over preference");
  assert.equal(row.poolPriceQuotePerBaseE18, 125n * USD_SCALE);
  assert.equal(row.hourlyCloses.length, 24);
  assert.equal(row.hourlyCloses[0]?.closeUsdE18, 102n * USD_SCALE);
  assert.equal(row.hourlyCloses.at(-1)?.closeUsdE18, 125n * USD_SCALE);
  assert.equal(row.priceChange24hE18, ((125n - 101n) * USD_SCALE) / 101n, "uses the canonical close 24 hours earlier");
  assert(row.hourlyCloses.every((close) => close.quoteToken === TOKEN_Y));
  assert(row.hourlyCloses.every((close) => /^0x[0-9a-f]+$/.test(close.lastBlockHash)));
  const expectedVolume = Array.from({ length: 24 }, (_, index) => BigInt(index + 2) * BigInt(index + 102) * UNIT)
    .reduce((sum, value) => sum + value, 0n);
  assert.equal(row.volume24hUsdE18, expectedVolume, "uses only flows inside the strict 24-hour window");
  assert.equal(row.lpNetSwapFees24hUsdE18, row.volume24hUsdE18! / 100n);
  assert.equal(row.asOfBlock, 25n);
  assert.equal(row.marketMetadata, null);
});

test("historical discovery never leaks a later update from the same hourly bucket", () => {
  const engine = seededEngine();
  const timestamp = 25 * 3_600 + 120;
  const futurePrice = 500n * USD_SCALE;
  engine.ingestBlock({
    chainId: 4663,
    number: 26n,
    hash: `0x${"1a".padStart(64, "0")}`,
    parentHash: `0x${"19".padStart(64, "0")}`,
    timestamp,
    events: [{
      ...identity(),
      kind: "swap",
      amountInX: UNIT,
      amountInY: 0n,
      feeX: UNIT / 100n,
      feeY: 0n,
      protocolFeeX: 0n,
      protocolFeeY: 0n,
      reserveX: 100n * UNIT,
      reserveY: 100n * UNIT,
      marketPriceQuoteE18: futurePrice,
      activeId: 8_388_608,
      binStep: 10
    }],
    prices: [
      fixedPrice(TOKEN_X, "x-usd", futurePrice, timestamp, 26n),
      fixedPrice(TOKEN_Y, "y-usd", USD_SCALE, timestamp, 26n)
    ]
  });

  const [row] = engine.queryPoolDiscovery({
    pools: [{ pair: PAIR }],
    asOfTimestamp: 25 * 3_600 + 60
  });
  assert(row);
  assert.equal(row.poolPriceQuotePerBaseE18, 125n * USD_SCALE);
  assert.equal(row.hourlyCloses.at(-1)?.closeUsdE18, 124n * USD_SCALE);
  assert(!row.hourlyCloses.some((close) => close.closeUsdE18 === futurePrice));
});

test("pool discovery safely inverts the active-bin price only when no candle orientation exists", () => {
  const engine = new AnalyticsEngine([], { assumeCompleteHistory: true });
  engine.ingestBlock({
    chainId: 4663,
    number: 1n,
    hash: "0x01",
    parentHash: "0x00",
    timestamp: 60,
    prices: [],
    events: [{
      ...identity(),
      kind: "swap",
      amountInX: UNIT,
      amountInY: 0n,
      feeX: 0n,
      feeY: 0n,
      protocolFeeX: 0n,
      protocolFeeY: 0n,
      reserveX: UNIT,
      reserveY: UNIT,
      marketPriceQuoteE18: 2n * USD_SCALE
    }]
  });
  const [row] = engine.queryPoolDiscovery({ pools: [{ pair: PAIR, preferredQuoteToken: TOKEN_X }] });
  assert(row);
  assert.equal(row.hourlyCloses.length, 0);
  assert.equal(row.displayBaseToken, TOKEN_Y);
  assert.equal(row.displayQuoteToken, TOKEN_X);
  assert.equal(row.poolPriceQuotePerBaseE18, USD_SCALE / 2n);
});

test("DEX Screener enrichment batches misses, exact-matches chain/base, rejects FDV, and caches results", async () => {
  let fetches = 0;
  const provider = new DexScreenerMarketMetadataProvider({
    fetch: async (input) => {
      fetches += 1;
      const url = String(input);
      const addresses = url.slice(url.lastIndexOf("/") + 1).split(",");
      const body = addresses.flatMap((address, index) => index === 0
        ? [
            dexPair(address, 10, 100, "0xbbb", "https://cdn.dexscreener.com/cms/images/a.png?format=auto"),
            dexPair(address, 20, 200, "0xaaa", "https://cdn.dexscreener.com/cms/images/b.png?format=auto"),
            { ...dexPair(TOKEN_Z, 1_000, 999, "0xquote", null), quoteToken: { address }, fdv: 999_999 }
          ]
        : [{ ...dexPair(address, index, undefined, `0x${index}`, null), fdv: 777_000 }]
      );
      return jsonResponse(body);
    }
  });
  const requests = Array.from({ length: 31 }, (_, index) => ({
    chainId: 4663,
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`
  }));
  const first = await provider.load(requests);
  assert.equal(fetches, 2, "provider requests are batched at 30 token addresses");
  assert.equal(first.get(marketMetadataLookupKey(4663, requests[0]!.address))?.marketCapUsdE18, 200n * USD_SCALE);
  assert.match(first.get(marketMetadataLookupKey(4663, requests[0]!.address))?.logoPath ?? "", /^\/token-images\/[0-9a-f]{64}$/);
  assert.equal(first.get(marketMetadataLookupKey(4663, requests[1]!.address))?.marketCapUsdE18, null, "FDV is not substituted");
  await provider.load(requests);
  assert.equal(fetches, 2, "successful and negative entries are cached");

  const local = await provider.load([{ chainId: 31_337, address: TOKEN_X }]);
  assert.equal(local.get(marketMetadataLookupKey(31_337, TOKEN_X)), null);
  assert.equal(fetches, 2, "unsupported local/test chains fail closed without provider traffic");
});

test("DEX Screener provider failures are negatively cached and isolated", async () => {
  let now = 1_000;
  let fetches = 0;
  const provider = new DexScreenerMarketMetadataProvider({
    clock: () => now,
    failureTtlMs: 100,
    fetch: async () => {
      fetches += 1;
      throw new Error("provider unavailable");
    }
  });
  const request = [{ chainId: 4663, address: TOKEN_X }];
  assert.equal((await provider.load(request)).get(marketMetadataLookupKey(4663, TOKEN_X)), null);
  assert.equal((await provider.load(request)).get(marketMetadataLookupKey(4663, TOKEN_X)), null);
  assert.equal(fetches, 1);
  now += 101;
  await provider.load(request);
  assert.equal(fetches, 2);
});

test("DEX Screener metadata and image requests reject redirects before any target fetch", async () => {
  let metadataFetches = 0;
  const metadataProvider = new DexScreenerMarketMetadataProvider({
    fetch: async (_input, init) => {
      metadataFetches += 1;
      assert.equal(init?.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:8545/private" }
      });
    }
  });
  assert.equal(
    (await metadataProvider.load([{ chainId: 4663, address: TOKEN_X }]))
      .get(marketMetadataLookupKey(4663, TOKEN_X)),
    null
  );
  assert.equal(metadataFetches, 1, "the redirect target is never followed");

  let imageFetches = 0;
  const imageProvider = new DexScreenerMarketMetadataProvider({
    fetch: async (input, init) => {
      imageFetches += 1;
      assert.equal(init?.redirect, "manual");
      if (String(input).includes("/tokens/v1/")) {
        return jsonResponse([dexPair(
          TOKEN_X,
          1,
          10,
          "0x1",
          "https://cdn.dexscreener.com/cms/images/a.png"
        )]);
      }
      return responseWithUrl(
        new Uint8Array(),
        "image/png",
        "https://cdn.dexscreener.com/cms/images/a.png",
        302,
        { location: "http://169.254.169.254/latest/meta-data" }
      );
    }
  });
  const logoPath = (await imageProvider.load([{ chainId: 4663, address: TOKEN_X }]))
    .get(marketMetadataLookupKey(4663, TOKEN_X))?.logoPath;
  assert(logoPath);
  assert.equal(await imageProvider.loadImage(logoPath.slice("/token-images/".length)), null);
  assert.equal(imageFetches, 2, "the image redirect target is never followed");
});

test("token image proxy is opaque, official-host-only, raster-validated, and bounded", async () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  let imageMode: "png" | "svg" | "large" = "png";
  const provider = new DexScreenerMarketMetadataProvider({
    maxImageBytes: 16,
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("/tokens/v1/")) {
        return jsonResponse([dexPair(TOKEN_X, 1, 10, "0x1", "https://cdn.dexscreener.com/cms/images/a.png?format=auto")]);
      }
      if (imageMode === "svg") return responseWithUrl("<svg/>", "image/svg+xml", url);
      if (imageMode === "large") return responseWithUrl(new Uint8Array(17), "image/png", url);
      return responseWithUrl(png, "image/png", url);
    }
  });
  const metadata = (await provider.load([{ chainId: 4663, address: TOKEN_X }]))
    .get(marketMetadataLookupKey(4663, TOKEN_X));
  assert(metadata?.logoPath);
  const opaqueKey = metadata.logoPath.slice("/token-images/".length);
  const image = await provider.loadImage(opaqueKey);
  assert.equal(image?.contentType, "image/png");
  assert.deepEqual(image?.body, png);
  assert.equal(await provider.loadImage("https://evil.example/image.png"), null);
  assert.equal(sanitizeDexScreenerImageUrl("https://evil.example/image.png"), null);
  assert.equal(sanitizeDexScreenerImageUrl("http://cdn.dexscreener.com/a.png"), null);

  for (const mode of ["svg", "large"] as const) {
    imageMode = mode;
    const rejecting = new DexScreenerMarketMetadataProvider({
      maxImageBytes: 16,
      fetch: async (input) => String(input).includes("/tokens/v1/")
        ? jsonResponse([dexPair(TOKEN_X, 1, 10, "0x1", "https://cdn.dexscreener.com/cms/images/a.png")])
        : mode === "svg"
          ? responseWithUrl("<svg/>", "image/svg+xml", String(input))
          : responseWithUrl(new Uint8Array(17), "image/png", String(input))
    });
    const path = (await rejecting.load([{ chainId: 4663, address: TOKEN_X }]))
      .get(marketMetadataLookupKey(4663, TOKEN_X))?.logoPath;
    assert(path);
    assert.equal(await rejecting.loadImage(path.slice("/token-images/".length)), null);
  }
});

test("GraphQL discovery isolates provider failure and CORS covers both local origins and image proxy", async () => {
  const image: ProxiedTokenImage = {
    body: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    contentType: "image/png",
    etag: '"image"'
  };
  const provider: MarketMetadataProvider = {
    load: async () => { throw new Error("provider failure"); },
    loadImage: async (key) => key === "a".repeat(64) ? image : null
  };
  const service = await AnalyticsApiService.create({ engine: seededEngine(), marketMetadataProvider: provider });
  const query = await service.execute(`query($pools: [PoolDiscoveryRequest!]!) {
    poolDiscovery(pools: $pools) {
      pair chainId displayBaseToken displayQuoteToken poolPriceQuotePerBaseE18
      hourlyCloses { startTimestamp closeUsdE18 firstBlockHash lastBlockHash }
      priceChange24hE18 tvlUsdE18 lpNetSwapFees24hUsdE18 volume24hUsdE18
      status missingPriceTokens asOfBlock asOfBlockHash asOfTimestamp
      marketMetadata { marketCapUsdE18 source fetchedAt logoPath logoSource }
    }
  }`, { pools: [{ pair: PAIR, preferredQuoteToken: TOKEN_Y }] });
  assert.equal(query.errors, undefined);
  const row = (query.data?.poolDiscovery as Array<{ marketMetadata: unknown; status: string }>)[0];
  assert.equal(row?.marketMetadata, null);
  assert.equal(row?.status, "READY");

  const server = await startAnalyticsHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    corsOrigins: ["http://127.0.0.1:15173", "http://localhost:15173"]
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    for (const origin of ["http://127.0.0.1:15173", "http://localhost:15173"]) {
      for (const path of ["/graphql", "/events/candles", `/token-images/${"a".repeat(64)}`]) {
        const response = await fetch(`${base}${path}`, { method: "OPTIONS", headers: { origin } });
        assert.equal(response.status, 204, `${origin} may preflight ${path}`);
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
      }
    }
    const tokenImage = await fetch(`${base}/token-images/${"a".repeat(64)}`, {
      headers: { origin: "http://localhost:15173" }
    });
    assert.equal(tokenImage.status, 200);
    assert.equal(tokenImage.headers.get("content-type"), "image/png");
    assert.equal(tokenImage.headers.get("x-content-type-options"), "nosniff");
    assert.equal(tokenImage.headers.get("access-control-allow-origin"), "http://localhost:15173");
    assert.equal((await tokenImage.arrayBuffer()).byteLength, image.body.byteLength);
    const arbitrary = await fetch(`${base}/token-images/${"a".repeat(64)}?url=https://evil.example/a.png`);
    assert.equal(arbitrary.status, 405);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("decimal market-cap parsing is fixed-point and rejects invalid provider values", () => {
  assert.equal(decimalUsdToE18("123.45"), 123_450_000_000_000_000_000n);
  assert.equal(decimalUsdToE18(1.25e3), 1_250n * USD_SCALE);
  assert.equal(decimalUsdToE18(-1), null);
  assert.equal(decimalUsdToE18(Number.POSITIVE_INFINITY), null);
});

function seededEngine(): AnalyticsEngine {
  const engine = new AnalyticsEngine(policies, { assumeCompleteHistory: true });
  let parentHash = "0x00" as `0x${string}`;
  for (let index = 1; index <= 25; index += 1) {
    const priceValue = BigInt(100 + index) * USD_SCALE;
    const hash = `0x${index.toString(16).padStart(64, "0")}` as `0x${string}`;
    const timestamp = index * 3_600 + 60;
    const event: SwapAnalyticsEvent = {
      ...identity(),
      kind: "swap",
      amountInX: BigInt(index) * UNIT,
      amountInY: 0n,
      feeX: BigInt(index) * UNIT / 100n,
      feeY: 0n,
      protocolFeeX: 0n,
      protocolFeeY: 0n,
      reserveX: 100n * UNIT,
      reserveY: 100n * UNIT,
      marketPriceQuoteE18: priceValue,
      activeId: 8_388_608,
      binStep: 10
    };
    engine.ingestBlock({
      chainId: 4663,
      number: BigInt(index),
      hash,
      parentHash,
      timestamp,
      events: [event],
      prices: [
        fixedPrice(TOKEN_X, "x-usd", priceValue, timestamp, BigInt(index)),
        fixedPrice(TOKEN_Y, "y-usd", USD_SCALE, timestamp, BigInt(index))
      ]
    });
    parentHash = hash;
  }
  return engine;
}

function identity() {
  return { pair: PAIR, tokenX: TOKEN_X, tokenY: TOKEN_Y, decimalsX: 18, decimalsY: 18 } as const;
}

function fixedPrice(token: string, feedId: string, priceUsdE18: bigint, observedAt: number, sequence: bigint) {
  return {
    token,
    source: "fixed-test" as const,
    feedId,
    priceUsdE18,
    confidenceUsdE18: priceUsdE18 / 1_000n,
    observedAt,
    sequence,
    verifiedBy: "test"
  };
}

function dexPair(address: string, liquidity: number, marketCap: number | undefined, pairAddress: string, imageUrl: string | null) {
  return {
    chainId: "robinhood",
    pairAddress,
    baseToken: { address },
    quoteToken: { address: TOKEN_Y },
    liquidity: { usd: liquidity },
    ...(marketCap === undefined ? {} : { marketCap }),
    fdv: 999_999_999,
    info: imageUrl === null ? {} : { imageUrl }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function responseWithUrl(
  body: BodyInit,
  contentType: string,
  url: string,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  const response = new Response(body, {
    status,
    headers: { "content-type": contentType, ...extraHeaders }
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
