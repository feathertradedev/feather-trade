import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import { defineConfig, loadEnv } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));
const sdkSrc = resolve(rootDir, "../../packages/sdk/src");
const zeroAddress = "0x0000000000000000000000000000000000000000";
const disabledLegacyRoutingConstructorArgs = [
  "routerFactoryV1",
  "routerFactoryV2_1",
  "routerLegacyFactoryV2",
  "routerLegacyRouterV2"
] as const;
const anvilAddresses = new Set([
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
  "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc",
  "0x976ea74026e726554db657fa54763abd0c3a0aa9",
  "0x14dc79964da2c08b23698b3d3cc7ca32193d9955",
  "0x23618e81e3f5cdf7f54c3d65f7fbc0abf5b21e8f",
  "0xa0ee7a142d267c1f36714e4a8f75612f20a79720"
]);

interface PublicManifestShape {
  chainId?: unknown;
  contracts?: Record<string, unknown>;
  constructorArgs?: Record<string, unknown>;
  deployer?: unknown;
  endpoints?: Record<string, unknown>;
  environment?: unknown;
  ownership?: Record<string, unknown>;
  quoteAssets?: Record<string, unknown>;
  schemaVersion?: unknown;
  tokens?: Record<string, unknown>;
}

interface PublicTokenListShape {
  chainId?: unknown;
  environment?: unknown;
  schemaVersion?: unknown;
  tokens?: Array<{
    address?: unknown;
    id?: unknown;
    logoURI?: unknown;
    name?: unknown;
    symbol?: unknown;
    tags?: unknown;
  }>;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  const publicReleaseEnvironment = env.VITE_PUBLIC_RELEASE_ENV;
  validatePublicReleaseEnvironment(publicReleaseEnvironment, env);

  return {
    plugins: [
      mdx({
        providerImportSource: "@mdx-js/react",
        rehypePlugins: [rehypeSlug],
        remarkPlugins: [remarkGfm, remarkFrontmatter, [remarkMdxFrontmatter, { name: "frontmatter" }]]
      }),
      react()
    ],
    define: {
      __LOCALNET_MANIFEST__: localnetManifestDefine(env.VITE_LOCALNET_MANIFEST_PATH),
      __PUBLIC_RELEASE_ENV__: publicReleaseEnvironment === undefined ? "undefined" : JSON.stringify(publicReleaseEnvironment),
      __ROBINHOOD_TESTNET_MANIFEST__: manifestDefine(env.VITE_ROBINHOOD_TESTNET_MANIFEST_PATH, {
        chainId: 46_630,
        environment: "testnet",
        releaseEnvironmentKey: "robinhoodTestnet",
        publicReleaseEnvironment
      }),
      __ROBINHOOD_MANIFEST__: manifestDefine(env.VITE_ROBINHOOD_MANIFEST_PATH, {
        chainId: 4_663,
        environment: "mainnet",
        releaseEnvironmentKey: "robinhood",
        publicReleaseEnvironment
      })
    },
    resolve: {
      alias: {
        "@robinhood-lb/sdk/abi": resolve(sdkSrc, "abi.ts"),
        "@robinhood-lb/sdk/chains": resolve(sdkSrc, "chains.ts"),
        "@robinhood-lb/sdk/client": resolve(sdkSrc, "client.ts"),
        "@robinhood-lb/sdk/endpoints": resolve(sdkSrc, "endpoints.ts"),
        "@robinhood-lb/sdk/liquidity": resolve(sdkSrc, "liquidity.ts"),
        "@robinhood-lb/sdk/manifest": resolve(sdkSrc, "manifest.ts"),
        "@robinhood-lb/sdk/registry": resolve(sdkSrc, "registry.ts"),
        "@robinhood-lb/sdk/swap": resolve(sdkSrc, "swap.ts"),
        "@robinhood-lb/sdk/tokens": resolve(sdkSrc, "tokens.ts")
      }
    },
    server: {
      port: 5173,
      strictPort: false
    },
    build: {
      chunkSizeWarningLimit: 700
    }
  };
});

function localnetManifestDefine(path: string | undefined): string {
  if (path === undefined || path.length === 0) return "undefined";

  const absolutePath = resolve(rootDir, "../..", path);
  if (!existsSync(absolutePath)) {
    throw new Error(`Localnet web manifest override does not exist: ${path}`);
  }

  const manifest = JSON.parse(readFileSync(absolutePath, "utf8")) as PublicManifestShape;
  if (manifest.schemaVersion !== "lb.localnet.v1" || manifest.environment !== "localnet" || manifest.chainId !== 31_337) {
    throw new Error(`Localnet web manifest override must use lb.localnet.v1 for chain 31337: ${path}`);
  }

  return JSON.stringify(manifest);
}

function manifestDefine(
  path: string | undefined,
  options: {
    chainId: number;
    environment: "testnet" | "mainnet";
    publicReleaseEnvironment?: string;
    releaseEnvironmentKey: "robinhoodTestnet" | "robinhood";
  }
): string {
  if (path === undefined || path.length === 0) {
    return "undefined";
  }

  if (options.publicReleaseEnvironment !== undefined && path.endsWith("dry-run.json")) {
    throw new Error(`Public web builds must not embed dry-run manifests: ${path}`);
  }

  const absolutePath = resolve(rootDir, "../..", path);
  if (!existsSync(absolutePath)) {
    throw new Error(`Public web manifest override does not exist: ${path}`);
  }

  const manifest = JSON.parse(readFileSync(absolutePath, "utf8")) as PublicManifestShape;

  if (manifest.schemaVersion !== "lb.robinhood.v1") {
    throw new Error(`Public web manifest override must use lb.robinhood.v1: ${path}`);
  }

  if (manifest.environment !== options.environment || manifest.chainId !== options.chainId) {
    throw new Error(`Public web manifest override ${path} does not match ${options.environment} chain ${options.chainId}`);
  }

  if (options.publicReleaseEnvironment === options.releaseEnvironmentKey) {
    validatePublicManifest(path, manifest);
    validatePublicTokenPolicy(path, manifest, options);
  }

  return JSON.stringify(manifest);
}

function validatePublicReleaseEnvironment(environment: string | undefined, env: Record<string, string>): void {
  if (environment === undefined || environment.length === 0) {
    return;
  }

  if (environment === "robinhoodTestnet" && !env.VITE_ROBINHOOD_TESTNET_MANIFEST_PATH) {
    throw new Error("VITE_PUBLIC_RELEASE_ENV=robinhoodTestnet requires VITE_ROBINHOOD_TESTNET_MANIFEST_PATH");
  }

  if (environment === "robinhoodTestnet" && env.VITE_ANALYTICS_ROBINHOOD_TESTNET_URL) {
    assertPublicEndpoint("build environment", "VITE_ANALYTICS_ROBINHOOD_TESTNET_URL", env.VITE_ANALYTICS_ROBINHOOD_TESTNET_URL, true);
  }

  if (environment === "robinhood" && !env.VITE_ROBINHOOD_MANIFEST_PATH) {
    throw new Error("VITE_PUBLIC_RELEASE_ENV=robinhood requires VITE_ROBINHOOD_MANIFEST_PATH");
  }

  if (environment === "robinhood" && env.VITE_ANALYTICS_ROBINHOOD_URL) {
    assertPublicEndpoint("build environment", "VITE_ANALYTICS_ROBINHOOD_URL", env.VITE_ANALYTICS_ROBINHOOD_URL, true);
  }

  if (environment !== "robinhoodTestnet" && environment !== "robinhood") {
    throw new Error("VITE_PUBLIC_RELEASE_ENV must be robinhoodTestnet or robinhood");
  }
}

function validatePublicManifest(path: string, manifest: PublicManifestShape): void {
  assertNoLocalnetManifestFields(path, manifest);
  assertPublicEndpoint(path, "endpoints.rpcUrl", manifest.endpoints?.rpcUrl, true);
  assertPublicEndpoint(path, "endpoints.indexerUrl", manifest.endpoints?.indexerUrl, true);
  assertPublicEndpoint(path, "endpoints.apiUrl", manifest.endpoints?.apiUrl, false);
  assertPublicEndpoint(path, "endpoints.tokenListUrl", manifest.endpoints?.tokenListUrl, false);

  for (const key of ["lbFactory", "lbPairImplementation", "lbRouter", "lbQuoter"]) {
    assertPublicAddress(path, `contracts.${key}`, manifest.contracts?.[key]);
  }

  for (const key of ["feeRecipient", "initialOwner", "lbFactoryOwner"]) {
    assertPublicAddress(path, `ownership.${key}`, manifest.ownership?.[key]);
  }

  assertPublicAddress(path, "deployer", manifest.deployer);
  assertPublicAddress(path, "tokens.wrappedNative", manifest.tokens?.wrappedNative);
  assertDisabledLegacyRouting(path, manifest.constructorArgs);
}

function assertDisabledLegacyRouting(path: string, constructorArgs: Record<string, unknown> | undefined): void {
  for (const key of disabledLegacyRoutingConstructorArgs) {
    const value = constructorArgs?.[key];
    if (typeof value !== "string" || value.toLowerCase() !== zeroAddress) {
      throw new Error(`Public web manifest ${path} constructorArgs.${key} must be the zero address for V2.2-only routing`);
    }
  }
}

function assertNoLocalnetManifestFields(path: string, manifest: PublicManifestShape): void {
  for (const field of ["seededPools", "smoke"]) {
    if (Object.prototype.hasOwnProperty.call(manifest, field)) {
      throw new Error(`Public web manifest ${path} must not include localnet-only ${field}`);
    }
  }
}

function assertPublicEndpoint(path: string, field: string, value: unknown, required: boolean): void {
  if (value === null || value === undefined || value === "") {
    if (required) {
      throw new Error(`Public web manifest ${path} requires ${field}`);
    }

    return;
  }

  if (typeof value !== "string") {
    throw new Error(`Public web manifest ${path} ${field} must be a URL string`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Public web manifest ${path} ${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Public web manifest ${path} ${field} must use https`);
  }

  if (
    isLocalEndpointHost(url.hostname)
  ) {
    throw new Error(`Public web manifest ${path} ${field} must not use a local host`);
  }
}

function assertPublicAddress(path: string, field: string, value: unknown): void {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error(`Public web manifest ${path} ${field} must be an EVM address`);
  }

  const normalized = value.toLowerCase();
  if (normalized === zeroAddress || anvilAddresses.has(normalized)) {
    throw new Error(`Public web manifest ${path} ${field} must be a real public deployment address`);
  }
}

function validatePublicTokenPolicy(
  manifestPath: string,
  manifest: PublicManifestShape,
  options: { chainId: number; releaseEnvironmentKey: "robinhoodTestnet" | "robinhood" }
): void {
  const tokenListPath = resolve(
    rootDir,
    "../../packages/sdk/src/token-lists",
    options.releaseEnvironmentKey === "robinhood" ? "robinhood.json" : "robinhood-testnet.json"
  );
  const tokenList = JSON.parse(readFileSync(tokenListPath, "utf8")) as PublicTokenListShape;

  if (tokenList.schemaVersion !== "lb.token-list.v1" || tokenList.chainId !== options.chainId) {
    throw new Error(`Public token list ${tokenListPath} does not match chain ${options.chainId}`);
  }

  if (tokenList.environment !== options.releaseEnvironmentKey) {
    throw new Error(`Public token list ${tokenListPath} does not match ${options.releaseEnvironmentKey}`);
  }

  if (!Array.isArray(tokenList.tokens) || tokenList.tokens.length === 0) {
    throw new Error(`Public token list ${tokenListPath} must include at least one token`);
  }

  const quoteAssets = new Set(
    Object.values(manifest.quoteAssets ?? {})
      .filter((value): value is string => typeof value === "string" && value.toLowerCase() !== zeroAddress)
      .map((value) => value.toLowerCase())
  );
  const quoteTokens: Array<{ address: string; tags: string[]; label: string }> = [];
  let wrappedNativeAddress: string | null = null;

  for (const [index, token] of tokenList.tokens.entries()) {
    const tokenPath = `${tokenListPath}.tokens[${index}]`;
    assertPublicAddress(manifestPath, tokenPath, token.address);

    if (typeof token.name === "string" && /\bmock\b/i.test(token.name)) {
      throw new Error(`${tokenPath}.name must not describe public assets as mocks`);
    }

    if (!Array.isArray(token.tags) || !token.tags.every((tag) => typeof tag === "string")) {
      throw new Error(`${tokenPath}.tags must be a string array`);
    }

    const tags = token.tags as string[];
    if (tags.includes("mock") || tags.includes("localnet")) {
      throw new Error(`${tokenPath}.tags must not include mock or localnet`);
    }

    assertPublicLogo(tokenListPath, tokenPath, token.logoURI);

    if (tags.includes("wrapped-native")) {
      wrappedNativeAddress = String(token.address).toLowerCase();
    }

    if (tags.includes("quote")) {
      quoteTokens.push({
        address: String(token.address).toLowerCase(),
        label: typeof token.symbol === "string" ? token.symbol : typeof token.id === "string" ? token.id : tokenPath,
        tags
      });
    }
  }

  if (wrappedNativeAddress !== String(manifest.tokens?.wrappedNative).toLowerCase()) {
    throw new Error(`${tokenListPath}: wrapped-native token must match ${manifestPath}.tokens.wrappedNative`);
  }

  for (const token of quoteTokens) {
    if (!quoteAssets.has(token.address)) {
      throw new Error(`${tokenListPath}: quote token ${token.label} is not present in ${manifestPath}.quoteAssets`);
    }
  }

  if (options.releaseEnvironmentKey === "robinhood") {
    if (quoteTokens.length !== 1) {
      throw new Error(`${tokenListPath}: expected exactly one Robinhood mainnet quote token, got ${quoteTokens.length}`);
    }

    const [quoteToken] = quoteTokens;
    if (!quoteToken.tags.includes("canonical") || !quoteToken.tags.includes("stablecoin")) {
      throw new Error(`${tokenListPath}: Robinhood mainnet quote token must be canonical and stablecoin`);
    }
  }
}

function assertPublicLogo(tokenListPath: string, tokenPath: string, logoURI: unknown): void {
  if (typeof logoURI !== "string" || !/^\/token-assets\/[a-z0-9-]+\.svg$/.test(logoURI)) {
    throw new Error(`${tokenPath}.logoURI must use /token-assets/<id>.svg`);
  }

  const logoPath = resolve(rootDir, "public", logoURI.replace(/^\/+/, ""));
  if (!existsSync(logoPath)) {
    throw new Error(`${tokenPath}.logoURI references missing asset ${logoPath}`);
  }

  const svg = readFileSync(logoPath, "utf8");
  if (!svg.includes("<svg") || /<script/i.test(svg)) {
    throw new Error(`${tokenPath}.logoURI references an unsafe SVG asset in ${tokenListPath}`);
  }
}

function isLocalEndpointHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^::ffff:127\./.test(host) ||
    /^0:0:0:0:0:ffff:127\./.test(host) ||
    /^::ffff:7f[0-9a-f]{2}:/.test(host) ||
    /^0:0:0:0:0:ffff:7f[0-9a-f]{2}:/.test(host)
  );
}
