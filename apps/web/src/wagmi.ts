import { createAppKit } from "@reown/appkit/react";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { localnetChain, robinhoodChain, robinhoodTestnetChain, sepoliaChain } from "@robinhood-lb/sdk/chains";
import { createConfig, http } from "wagmi";

import { publicReleaseEnvironment, registries } from "./config";

const reownProjectId = import.meta.env.VITE_REOWN_PROJECT_ID?.trim() ?? "";
const appOrigin = typeof window === "undefined" ? "https://feather.trade" : window.location.origin;
const configuredWalletModalReadyGraceMs = Number(import.meta.env.VITE_WALLET_MODAL_READY_GRACE_MS);
const WALLET_MODAL_READY_GRACE_MS = Number.isFinite(configuredWalletModalReadyGraceMs)
  ? Math.min(10_000, Math.max(0, configuredWalletModalReadyGraceMs))
  : 2_000;

const walletNetworks = (
  publicReleaseEnvironment === "sepolia"
    ? [sepoliaChain]
    : publicReleaseEnvironment === "robinhoodTestnet"
      ? [robinhoodTestnetChain]
      : publicReleaseEnvironment === "robinhood"
        ? [robinhoodChain]
        : [localnetChain, sepoliaChain, robinhoodTestnetChain, robinhoodChain]
) as [
  typeof localnetChain | typeof sepoliaChain | typeof robinhoodTestnetChain | typeof robinhoodChain,
  ...Array<typeof localnetChain | typeof sepoliaChain | typeof robinhoodTestnetChain | typeof robinhoodChain>
];

const walletTransports: Record<number, ReturnType<typeof http>> = publicReleaseEnvironment === "sepolia"
  ? { [sepoliaChain.id]: http(registries.sepolia.endpoints.rpcUrl) }
  : publicReleaseEnvironment === "robinhoodTestnet"
    ? { [robinhoodTestnetChain.id]: http(registries.robinhoodTestnet.endpoints.rpcUrl) }
    : publicReleaseEnvironment === "robinhood"
      ? { [robinhoodChain.id]: http(registries.robinhood.endpoints.rpcUrl) }
      : {
          [localnetChain.id]: http(registries.localnet.endpoints.rpcUrl),
          [sepoliaChain.id]: http(registries.sepolia.endpoints.rpcUrl),
          [robinhoodTestnetChain.id]: http(registries.robinhoodTestnet.endpoints.rpcUrl),
          [robinhoodChain.id]: http(registries.robinhood.endpoints.rpcUrl)
        };

const wagmiAdapter = reownProjectId
  ? new WagmiAdapter({
      multiInjectedProviderDiscovery: true,
      networks: walletNetworks,
      projectId: reownProjectId,
      ssr: false,
      transports: walletTransports
    })
  : null;

export const wagmiConfig = wagmiAdapter?.wagmiConfig ?? createConfig({
  chains: walletNetworks,
  connectors: [],
  multiInjectedProviderDiscovery: true,
  transports: walletTransports
});

let walletModalReady: Promise<void> | null = null;

function loadAppKit() {
  if (!wagmiAdapter) {
    throw new Error("Wallet modal is not configured");
  }
  const appKit = createAppKit({
      adapters: [wagmiAdapter],
      allWallets: "SHOW",
      allowUnsupportedChain: false,
      defaultNetwork: walletNetworks[0],
      enableBaseAccount: false,
      enableCoinbase: true,
      enableEIP6963: true,
      enableInjected: true,
      enableMobileFullScreen: true,
      enableNetworkSwitch: false,
      enableReconnect: false,
      enableWalletGuide: false,
      features: {
        allWallets: true,
        analytics: false,
        email: false,
        history: false,
        onramp: false,
        receive: false,
        send: false,
        socials: false,
        swaps: false
      },
      metadata: {
        description: "Liquidity Book trading with Feather Trade.",
        icons: [`${appOrigin}/feather/feather-mark-128.png`],
        name: "Feather Trade",
        url: appOrigin
      },
      networks: walletNetworks,
      projectId: reownProjectId,
      themeMode: "dark",
      themeVariables: {
        "--w3m-accent": "#4ac57c",
        "--w3m-border-radius-master": "2px",
        "--w3m-color-mix": "#141614",
        "--w3m-color-mix-strength": 18,
        "--w3m-font-family": "Schibsted Grotesk, ui-sans-serif, system-ui, sans-serif",
        "--w3m-z-index": 100
      }
    });

  // AppKit installs the Wagmi adapter watchers during construction, before
  // React mounts WagmiProvider. Its ready promise also waits for Reown cloud
  // configuration and usage requests, which must never gate the application
  // shell. Catch that background work so a provider outage cannot create an
  // unhandled rejection or leave #root blank.
  walletModalReady = appKit.ready().catch((error: unknown) => {
    console.warn("Wallet modal remote initialization did not complete.", error);
  });

  return appKit;
}

type WalletModal = ReturnType<typeof loadAppKit>;

let appKit: WalletModal | null = null;
let appKitInitializationAttempted = false;
let walletModalOpen = false;
let walletModalSubscriptionAttached = false;
const walletModalSubscribers = new Set<(open: boolean) => void>();

export const walletModalConfigured = wagmiAdapter !== null;

export function walletModalIsOpen(): boolean {
  return walletModalOpen;
}

export function subscribeWalletModalOpen(listener: (open: boolean) => void): () => void {
  walletModalSubscribers.add(listener);
  listener(walletModalOpen);
  return () => walletModalSubscribers.delete(listener);
}

function observeWalletModal(appKit: WalletModal): void {
  if (walletModalSubscriptionAttached) return;
  walletModalSubscriptionAttached = true;
  const publish = (open: boolean) => {
    if (walletModalOpen === open) return;
    walletModalOpen = open;
    for (const listener of walletModalSubscribers) listener(open);
  };
  publish(appKit.getState().open);
  appKit.subscribeState((state) => publish(state.open));
}

function publishWalletModalOpen(open: boolean): void {
  if (walletModalOpen === open) return;
  walletModalOpen = open;
  for (const listener of walletModalSubscribers) listener(open);
}

function getWalletModal(): WalletModal | null {
  if (!walletModalConfigured) return null;
  if (appKitInitializationAttempted) return appKit;
  appKitInitializationAttempted = true;
  try {
    appKit = loadAppKit();
    observeWalletModal(appKit);
  } catch (error) {
    console.warn("Wallet modal could not initialize. The application will continue without it.", error);
  }
  return appKit;
}

export function initializeWalletModal(): void {
  getWalletModal();
}

async function waitForWalletModalReadiness(): Promise<void> {
  if (walletModalReady === null) return;
  await Promise.race([
    walletModalReady,
    new Promise<void>((resolve) => window.setTimeout(resolve, WALLET_MODAL_READY_GRACE_MS))
  ]);
}

export async function openWalletModal(): Promise<void> {
  const walletModal = getWalletModal();
  if (walletModal === null) {
    throw new Error("Wallet modal is not configured");
  }
  // Normal initialization completes quickly and provides the full WalletConnect
  // catalog. Bound this user-triggered wait so a cloud outage still fails open
  // to whatever local/injected connectors AppKit has already discovered.
  await waitForWalletModalReadiness();
  // Mark ownership before AppKit mounts its portal. This closes the small gap
  // in which an immediate Escape could otherwise reach the underlying wizard.
  publishWalletModalOpen(true);
  try {
    await walletModal.open({ view: "Connect" });
  } catch (error) {
    publishWalletModalOpen(false);
    throw error;
  }
}
