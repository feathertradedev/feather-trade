import type { Address } from "viem";

export const SUPPORTED_WALLET_RDNS = new Set(["com.brave.wallet", "io.metamask"]);

export type WalletFailureKind =
  | "missing"
  | "locked"
  | "permission-rejected"
  | "provider-error"
  | "switch-rejected";

export interface WalletFailure {
  action: string;
  kind: WalletFailureKind;
}

export function walletFailure(error: unknown, phase: "connect" | "switch"): WalletFailure {
  const code = nestedErrorCode(error);
  const message = nestedErrorMessage(error).toLowerCase();

  if (phase === "connect" && message.includes("provider not found")) {
    return { action: "Install or enable an EIP-1193 wallet, then reload this page.", kind: "missing" };
  }
  if (phase === "connect" && code === 4_100) {
    return { action: "The wallet has not authorized account access for this site. Grant account access, then retry.", kind: "provider-error" };
  }
  if (code === -32_002) {
    return { action: "A wallet request is already pending. Open the wallet and complete or reject it before retrying.", kind: "provider-error" };
  }
  if (code === 4_900 || code === 4_901) {
    return { action: "The wallet provider is disconnected. Reopen or reconnect the wallet, then retry.", kind: "provider-error" };
  }
  if (code === 4_001 || message.includes("user rejected") || message.includes("user denied")) {
    return phase === "switch"
      ? { action: "Network switch was rejected. Approve the switch in your wallet and retry.", kind: "switch-rejected" }
      : { action: "Account permission was rejected. Connect again and approve account access.", kind: "permission-rejected" };
  }

  return {
    action: phase === "switch"
      ? "The wallet could not switch networks. Check the wallet network settings and retry."
      : "The selected wallet returned an error. Open it, check its status, and retry.",
    kind: "provider-error"
  };
}

export function walletSessionIdentity(input: {
  address?: Address;
  chainId: number;
  connectorUid?: string;
  environment: string;
  status: string;
}): string {
  return [
    input.environment,
    input.status,
    input.connectorUid ?? "no-provider",
    input.address?.toLowerCase() ?? "no-owner",
    input.chainId.toString()
  ].join(":");
}

function nestedErrorCode(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const record = current as { cause?: unknown; code?: unknown };
    if (typeof record.code === "number") return record.code;
    current = record.cause;
  }
  return null;
}

function nestedErrorMessage(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const record = current as { cause?: unknown; message?: unknown; shortMessage?: unknown };
    if (typeof record.shortMessage === "string") messages.push(record.shortMessage);
    if (typeof record.message === "string") messages.push(record.message);
    current = record.cause;
  }
  return messages.join(" ");
}
