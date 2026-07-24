import type { PoolCreationMode } from "./pool-creation";

const DRAFT_PREFIX = "feather.pool-creation-draft.v1.";
const OPEN_PREFIX = "feather.pool-creation-open.v1.";
const inMemoryDrafts = new Map<string, PoolCreationDraft>();
const inMemoryOpenEnvironments = new Set<string>();

export interface PoolCreationDraft {
  tokenXInput: string;
  tokenYAddress: string;
  binStepInput: string;
  priceInput: string;
  mode: PoolCreationMode;
  riskAcknowledged: boolean;
  configured: boolean;
}

interface SessionStorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export function loadPoolCreationDraft(storage: Pick<SessionStorageLike, "getItem">, environment: string): PoolCreationDraft | null {
  const inMemory = inMemoryDrafts.get(environment);
  if (inMemory) return { ...inMemory };
  try {
    const raw = storage.getItem(`${DRAFT_PREFIX}${environment}`);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<PoolCreationDraft>;
    if (
      typeof value.tokenXInput !== "string" ||
      typeof value.tokenYAddress !== "string" ||
      typeof value.binStepInput !== "string" ||
      typeof value.priceInput !== "string" ||
      (value.mode !== "create-only" && value.mode !== "create-and-add") ||
      typeof value.riskAcknowledged !== "boolean" ||
      typeof value.configured !== "boolean" ||
      [value.tokenXInput, value.tokenYAddress, value.binStepInput, value.priceInput].some((field) => field.length > 256)
    ) return null;
    return value as PoolCreationDraft;
  } catch {
    return null;
  }
}

export function persistPoolCreationDraft(
  storage: Pick<SessionStorageLike, "setItem">,
  environment: string,
  draft: PoolCreationDraft
): void {
  inMemoryDrafts.set(environment, { ...draft });
  try {
    storage.setItem(`${DRAFT_PREFIX}${environment}`, JSON.stringify(draft));
  } catch {
    // Draft persistence is a continuity enhancement; exact review and
    // transaction safety never depend on it.
  }
}

export function poolCreationWasOpen(storage: Pick<SessionStorageLike, "getItem">, environment: string): boolean {
  return inMemoryOpenEnvironments.has(environment) || storage.getItem(`${OPEN_PREFIX}${environment}`) === "true";
}

export function setPoolCreationOpen(
  storage: Pick<SessionStorageLike, "removeItem" | "setItem">,
  environment: string,
  open: boolean
): void {
  if (open) inMemoryOpenEnvironments.add(environment);
  else inMemoryOpenEnvironments.delete(environment);
  try {
    if (open) storage.setItem(`${OPEN_PREFIX}${environment}`, "true");
    else storage.removeItem(`${OPEN_PREFIX}${environment}`);
  } catch {
    // The wizard remains usable in-memory when session storage is unavailable.
  }
}
