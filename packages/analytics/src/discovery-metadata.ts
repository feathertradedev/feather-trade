import { createHash } from "node:crypto";

import type { PoolDiscoveryMarketMetadata } from "./types.js";

const DEFAULT_API_BASE_URL = "https://api.dexscreener.com";
const DEFAULT_IMAGE_HOSTS = ["cdn.dexscreener.com"];
const DEFAULT_SUCCESS_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_NEGATIVE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_FAILURE_TTL_MS = 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 2_048;
const DEFAULT_MAX_IMAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_METADATA_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const PROVIDER_BATCH_SIZE = 30;

export interface MarketMetadataLookup {
  chainId: number;
  address: string;
}

export interface ProxiedTokenImage {
  body: Uint8Array;
  contentType: string;
  etag: string;
}

export interface MarketMetadataProvider {
  load(requests: readonly MarketMetadataLookup[]): Promise<Map<string, PoolDiscoveryMarketMetadata | null>>;
  loadImage(opaqueKey: string): Promise<ProxiedTokenImage | null>;
}

export interface DexScreenerMarketMetadataOptions {
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  apiBaseUrl?: string;
  imageHosts?: readonly string[];
  successTtlMs?: number;
  negativeTtlMs?: number;
  failureTtlMs?: number;
  maxEntries?: number;
  maxImageBytes?: number;
  maxMetadataBytes?: number;
  requestTimeoutMs?: number;
}

interface CacheEntry {
  expiresAt: number;
  metadata: PoolDiscoveryMarketMetadata | null;
  remoteLogoUrl: string | null;
  image: ProxiedTokenImage | null;
}

interface DexPair {
  chainId?: unknown;
  pairAddress?: unknown;
  baseToken?: { address?: unknown } | null;
  liquidity?: { usd?: unknown } | null;
  marketCap?: unknown;
  info?: { imageUrl?: unknown } | null;
}

export class DexScreenerMarketMetadataProvider implements MarketMetadataProvider {
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: () => number;
  readonly #apiBaseUrl: string;
  readonly #imageHosts: Set<string>;
  readonly #successTtlMs: number;
  readonly #negativeTtlMs: number;
  readonly #failureTtlMs: number;
  readonly #maxEntries: number;
  readonly #maxImageBytes: number;
  readonly #maxMetadataBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #imageKeys = new Map<string, string>();

  constructor(options: DexScreenerMarketMetadataOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#clock = options.clock ?? Date.now;
    this.#apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    this.#imageHosts = new Set((options.imageHosts ?? DEFAULT_IMAGE_HOSTS).map((host) => host.toLowerCase()));
    this.#successTtlMs = positiveSafeInteger(options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS, "successTtlMs");
    this.#negativeTtlMs = positiveSafeInteger(options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS, "negativeTtlMs");
    this.#failureTtlMs = positiveSafeInteger(options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS, "failureTtlMs");
    this.#maxEntries = positiveSafeInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.#maxImageBytes = positiveSafeInteger(options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES, "maxImageBytes");
    this.#maxMetadataBytes = positiveSafeInteger(
      options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES,
      "maxMetadataBytes"
    );
    this.#requestTimeoutMs = positiveSafeInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs"
    );
  }

  async load(requests: readonly MarketMetadataLookup[]): Promise<Map<string, PoolDiscoveryMarketMetadata | null>> {
    const normalized = new Map<string, MarketMetadataLookup>();
    for (const request of requests) {
      const address = canonicalAddress(request.address);
      if (!Number.isSafeInteger(request.chainId) || request.chainId <= 0) {
        throw new Error("Market metadata chain ID must be a positive safe integer");
      }
      normalized.set(marketMetadataLookupKey(request.chainId, address), { chainId: request.chainId, address });
    }

    const now = this.#clock();
    const missesBySlug = new Map<string, MarketMetadataLookup[]>();
    for (const [key, request] of normalized) {
      const cached = this.#cache.get(key);
      if (cached !== undefined && cached.expiresAt > now) {
        this.#touch(key, cached);
        continue;
      }
      if (cached !== undefined) this.#delete(key, cached);
      const slug = dexScreenerChainSlug(request.chainId);
      if (slug === null) {
        this.#set(key, { expiresAt: now + this.#negativeTtlMs, metadata: null, remoteLogoUrl: null, image: null });
        continue;
      }
      const misses = missesBySlug.get(slug) ?? [];
      misses.push(request);
      missesBySlug.set(slug, misses);
    }

    await Promise.all([...missesBySlug].flatMap(([slug, requestsForChain]) =>
      chunks(requestsForChain, PROVIDER_BATCH_SIZE).map((batch) => this.#fetchBatch(slug, batch, now))
    ));

    return new Map([...normalized].map(([key]) => [key, this.#cache.get(key)?.metadata ?? null]));
  }

  async loadImage(opaqueKey: string): Promise<ProxiedTokenImage | null> {
    if (!/^[0-9a-f]{64}$/.test(opaqueKey)) return null;
    const cacheKey = this.#imageKeys.get(opaqueKey);
    if (cacheKey === undefined) return null;
    const entry = this.#cache.get(cacheKey);
    if (entry === undefined || entry.expiresAt <= this.#clock() || entry.remoteLogoUrl === null) return null;
    if (entry.image !== null) return entry.image;

    const source = sanitizeDexScreenerImageUrl(entry.remoteLogoUrl, this.#imageHosts);
    if (source === null) return null;
    let response: Response;
    try {
      response = await this.#fetch(source, {
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
        redirect: "manual",
        signal: AbortSignal.timeout(this.#requestTimeoutMs)
      });
    } catch {
      return null;
    }
    if (!response.ok || sanitizeDexScreenerImageUrl(response.url, this.#imageHosts) === null) return null;
    const contentType = normalizeRasterContentType(response.headers.get("content-type"));
    if (contentType === null) return null;
    const advertisedLength = response.headers.get("content-length");
    if (advertisedLength !== null && Number(advertisedLength) > this.#maxImageBytes) return null;
    const body = await readBoundedBody(response, this.#maxImageBytes);
    if (body === null || !hasRasterSignature(body, contentType)) return null;
    const image = {
      body,
      contentType,
      etag: `"${createHash("sha256").update(body).digest("hex")}"`
    };
    entry.image = image;
    this.#touch(cacheKey, entry);
    return image;
  }

  async #fetchBatch(slug: string, requests: readonly MarketMetadataLookup[], now: number): Promise<void> {
    const addresses = requests.map((request) => request.address);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}/tokens/v1/${encodeURIComponent(slug)}/${addresses.join(",")}`, {
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(this.#requestTimeoutMs)
      });
      if (!response.ok) throw new Error(`DEX Screener returned ${response.status}`);
      const advertisedLength = response.headers.get("content-length");
      if (advertisedLength !== null && Number(advertisedLength) > this.#maxMetadataBytes) {
        throw new Error("DEX Screener response exceeds the metadata limit");
      }
      const body = await readBoundedBody(response, this.#maxMetadataBytes);
      if (body === null) throw new Error("DEX Screener response exceeds the metadata limit");
      const payload: unknown = JSON.parse(new TextDecoder().decode(body));
      if (!Array.isArray(payload)) throw new Error("DEX Screener response must be an array");
      for (const request of requests) {
        const exact = payload
          .filter((item): item is DexPair => isRecord(item))
          .filter((pair) =>
            typeof pair.chainId === "string" && pair.chainId.toLowerCase() === slug &&
            typeof pair.baseToken?.address === "string" && pair.baseToken.address.toLowerCase() === request.address
          )
          .sort(compareDexPairs)[0] ?? null;
        const key = marketMetadataLookupKey(request.chainId, request.address);
        if (exact === null) {
          this.#set(key, { expiresAt: now + this.#negativeTtlMs, metadata: null, remoteLogoUrl: null, image: null });
          continue;
        }
        const marketCapUsdE18 = decimalUsdToE18(exact.marketCap);
        const remoteLogoUrl = typeof exact.info?.imageUrl === "string"
          ? sanitizeDexScreenerImageUrl(exact.info.imageUrl, this.#imageHosts)
          : null;
        const opaqueKey = remoteLogoUrl === null ? null : opaqueImageKey(request.chainId, request.address);
        const metadata: PoolDiscoveryMarketMetadata = {
          marketCapUsdE18,
          source: "dex-screener",
          fetchedAt: Math.floor(now / 1_000),
          logoPath: opaqueKey === null ? null : `/token-images/${opaqueKey}`,
          logoSource: opaqueKey === null ? null : "dex-screener"
        };
        this.#set(key, {
          expiresAt: now + this.#successTtlMs,
          metadata,
          remoteLogoUrl,
          image: null
        });
      }
    } catch {
      for (const request of requests) {
        this.#set(marketMetadataLookupKey(request.chainId, request.address), {
          expiresAt: now + this.#failureTtlMs,
          metadata: null,
          remoteLogoUrl: null,
          image: null
        });
      }
    }
  }

  #set(key: string, entry: CacheEntry): void {
    const previous = this.#cache.get(key);
    if (previous !== undefined) this.#delete(key, previous);
    this.#cache.set(key, entry);
    if (entry.metadata?.logoPath !== null && entry.metadata?.logoPath !== undefined) {
      this.#imageKeys.set(entry.metadata.logoPath.slice("/token-images/".length), key);
    }
    while (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.entries().next().value as [string, CacheEntry] | undefined;
      if (oldest === undefined) break;
      this.#delete(oldest[0], oldest[1]);
    }
  }

  #touch(key: string, entry: CacheEntry): void {
    this.#cache.delete(key);
    this.#cache.set(key, entry);
  }

  #delete(key: string, entry: CacheEntry): void {
    this.#cache.delete(key);
    if (entry.metadata?.logoPath !== null && entry.metadata?.logoPath !== undefined) {
      this.#imageKeys.delete(entry.metadata.logoPath.slice("/token-images/".length));
    }
  }
}

export function marketMetadataLookupKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

export function dexScreenerChainSlug(chainId: number): string | null {
  switch (chainId) {
    case 1: return "ethereum";
    case 10: return "optimism";
    case 56: return "bsc";
    case 137: return "polygon";
    case 4663: return "robinhood";
    case 8453: return "base";
    case 42_161: return "arbitrum";
    case 43_114: return "avalanche";
    default: return null;
  }
}

export function sanitizeDexScreenerImageUrl(value: string, allowedHosts = new Set(DEFAULT_IMAGE_HOSTS)): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") return null;
    if (!allowedHosts.has(url.hostname.toLowerCase())) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function decimalUsdToE18(value: unknown): bigint | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) return null;
  const text = String(value).trim();
  if (text.length === 0 || text.length > 100) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) return null;
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const fraction = match[2] ?? "";
  const digits = `${match[1]}${fraction}`.replace(/^0+(?=\d)/, "");
  const scale = 18 + exponent - fraction.length;
  const amount = BigInt(digits);
  return scale >= 0 ? amount * 10n ** BigInt(scale) : amount / 10n ** BigInt(-scale);
}

function compareDexPairs(left: DexPair, right: DexPair): number {
  const liquidity = numericLiquidity(right.liquidity?.usd) - numericLiquidity(left.liquidity?.usd);
  if (liquidity !== 0) return liquidity;
  return String(left.pairAddress ?? "").toLowerCase().localeCompare(String(right.pairAddress ?? "").toLowerCase());
}

function numericLiquidity(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : -1;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
}

function opaqueImageKey(chainId: number, address: string): string {
  return createHash("sha256").update(`${chainId}:${address.toLowerCase()}`).digest("hex");
}

function canonicalAddress(value: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Market metadata token must be a canonical EVM address");
  return value.toLowerCase();
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRasterContentType(value: string | null): string | null {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return contentType === "image/png" || contentType === "image/jpeg" ||
    contentType === "image/webp" || contentType === "image/avif"
    ? contentType
    : null;
}

function hasRasterSignature(body: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") {
    return body.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => body[index] === byte);
  }
  if (contentType === "image/jpeg") return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (contentType === "image/webp") {
    return ascii(body, 0, 4) === "RIFF" && ascii(body, 8, 12) === "WEBP";
  }
  if (contentType === "image/avif") {
    return body.length >= 12 && ascii(body, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(body, 8, 12));
  }
  return false;
}

function ascii(body: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...body.slice(start, end));
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
