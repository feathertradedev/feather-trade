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
const configuredWalletModalOpenTimeoutMs = Number(import.meta.env.VITE_WALLET_MODAL_OPEN_TIMEOUT_MS);
const WALLET_MODAL_OPEN_TIMEOUT_MS = Number.isFinite(configuredWalletModalOpenTimeoutMs)
  ? Math.min(15_000, Math.max(250, configuredWalletModalOpenTimeoutMs))
  : 5_000;

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
let walletModalOpenGeneration = 0;
let walletModalOpenOperation: Promise<void> | null = null;
let walletModalUnavailableError: Error | null = null;
let walletModalCleanupGeneration: number | null = null;
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

function closeWalletModalSafely(walletModal: WalletModal, generation: number): void {
  publishWalletModalOpen(false);
  if (walletModalOpenGeneration !== generation || !walletModal.getState().open) return;
  if (walletModalCleanupGeneration === generation) return;
  walletModalCleanupGeneration = generation;
  try {
    void walletModal.close().catch((error: unknown) => {
      console.warn("Wallet modal cleanup did not complete.", error);
    });
  } catch (error) {
    console.warn("Wallet modal cleanup could not start.", error);
  }
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

async function performWalletModalOpen(generation: number): Promise<void> {
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
  const openPromise = Promise.resolve().then(() => walletModal.open({ view: "Connect" }));
  let timedOut = false;
  let openTimeout: number | undefined;
  try {
    await Promise.race([
      openPromise,
      new Promise<never>((_, reject) => {
        openTimeout = window.setTimeout(
          () => {
            timedOut = true;
            reject(new Error("Wallet chooser did not open before its safety deadline"));
          },
          WALLET_MODAL_OPEN_TIMEOUT_MS
        );
      })
    ]);
    if (walletModalOpenGeneration !== generation || !walletModal.getState().open) {
      throw new Error("Wallet chooser completed without entering its open state");
    }
  } catch (error) {
    if (timedOut) {
      walletModalUnavailableError = error instanceof Error
        ? error
        : new Error("Wallet chooser did not open before its safety deadline");
    }
    closeWalletModalSafely(walletModal, generation);
    // AppKit does not expose cancellation for the prefetch awaited by open().
    // If a timed-out request eventually settles and mounts its portal, close
    // that stale modal. The timeout latches AppKit unavailable for this page
    // session, so no newer AppKit attempt can be displaced by this cleanup.
    void openPromise.then(() => {
      closeWalletModalSafely(walletModal, generation);
    }).catch(() => {});
    throw error;
  } finally {
    if (openTimeout !== undefined) window.clearTimeout(openTimeout);
  }
}

export function openWalletModal(): Promise<void> {
  if (walletModalUnavailableError !== null) {
    return Promise.reject(walletModalUnavailableError);
  }
  if (walletModalOpenOperation !== null) {
    return walletModalOpenOperation;
  }
  if (walletModalIsOpen()) {
    return Promise.resolve();
  }

  const generation = ++walletModalOpenGeneration;
  walletModalCleanupGeneration = null;
  const operation = performWalletModalOpen(generation);
  walletModalOpenOperation = operation;
  void operation.then(
    () => {
      if (walletModalOpenOperation === operation) walletModalOpenOperation = null;
    },
    () => {
      if (walletModalOpenOperation === operation) walletModalOpenOperation = null;
    }
  );
  return operation;
}
