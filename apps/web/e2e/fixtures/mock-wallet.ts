import type { Page } from "@playwright/test";

export const LOCALNET_CHAIN_ID = 31_337;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46_630;
export const DEFAULT_ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

export interface MockWalletOptions {
  account?: `0x${string}`;
  allowTransactions?: boolean;
  chainId?: number;
  rejectTransactions?: boolean;
  transactionHash?: `0x${string}`;
}

export interface MockWalletSnapshot {
  accounts: string[];
  chainId: number;
  calls: string[];
  rejectTransactions: boolean;
  sentTransactions: unknown[];
  switchChainCalls: number[];
}

export async function installMockWallet(page: Page, options: MockWalletOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ account, allowTransactions, chainId, rejectTransactions, transactionHash }) => {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const state = {
        accounts: [account],
        chainId,
        calls: [] as string[],
        rejectTransactions,
        sentTransactions: [] as unknown[],
        switchChainCalls: [] as number[]
      };

      function emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      }

      function on(event: string, listener: (...args: unknown[]) => void) {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
      }

      function removeListener(event: string, listener: (...args: unknown[]) => void) {
        listeners.get(event)?.delete(listener);
      }

      function toHex(value: number) {
        return `0x${value.toString(16)}`;
      }

      async function request({ method, params }: { method: string; params?: unknown[] }) {
        state.calls.push(method);

        switch (method) {
          case "eth_accounts":
          case "eth_requestAccounts":
            return state.accounts;
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: state.accounts }] }];
          case "eth_chainId":
            return toHex(state.chainId);
          case "net_version":
            return String(state.chainId);
          case "wallet_switchEthereumChain": {
            const requested = params?.[0] as { chainId?: string } | undefined;
            if (typeof requested?.chainId !== "string") throw new Error("Missing chainId");
            const nextChainId = Number.parseInt(requested.chainId, 16);
            state.chainId = nextChainId;
            state.switchChainCalls.push(nextChainId);
            emit("chainChanged", toHex(nextChainId));
            return null;
          }
          case "wallet_addEthereumChain":
            return null;
          case "eth_sendTransaction":
            state.sentTransactions.push(params?.[0] ?? null);
            if (!allowTransactions) throw new Error("Mock wallet should not receive guarded transactions");
            if (state.rejectTransactions) {
              const rejection = new Error("User rejected the transaction request") as Error & { code: number };
              rejection.code = 4001;
              throw rejection;
            }
            return transactionHash;
          default:
            throw new Error(`Unhandled mock wallet method: ${method}`);
        }
      }

      const provider = {
        isMetaMask: true,
        request,
        on,
        removeListener,
        emit
      };

      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: provider
      });
      Object.defineProperty(window, "__mockWalletState", {
        configurable: true,
        value: state
      });

      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            info: {
              icon: "",
              name: "Mock Wallet",
              rdns: "com.robinhood-lb.mock-wallet",
              uuid: "robinhood-lb-mock-wallet"
            },
            provider
          }
        })
      );
    },
    {
      account: options.account ?? DEFAULT_ACCOUNT,
      allowTransactions: options.allowTransactions ?? false,
      chainId: options.chainId ?? LOCALNET_CHAIN_ID,
      rejectTransactions: options.rejectTransactions ?? false,
      transactionHash: options.transactionHash ?? "0x1111111111111111111111111111111111111111111111111111111111111111"
    }
  );
}

export async function readMockWallet(page: Page): Promise<MockWalletSnapshot> {
  return page.evaluate(() => {
    const state = window.__mockWalletState;
    return {
      accounts: [...state.accounts],
      chainId: state.chainId,
      calls: [...state.calls],
      rejectTransactions: state.rejectTransactions,
      sentTransactions: [...state.sentTransactions],
      switchChainCalls: [...state.switchChainCalls]
    };
  });
}

declare global {
  interface Window {
    __mockWalletState: {
      accounts: string[];
      chainId: number;
      calls: string[];
      rejectTransactions: boolean;
      sentTransactions: unknown[];
      switchChainCalls: number[];
    };
    ethereum?: unknown;
  }
}
