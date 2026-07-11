import type { Address } from "viem";

export type LbOperatorApprovalState =
  | "approved"
  | "unapproved"
  | "externally-revoked"
  | "wrong-pair"
  | "wrong-operator"
  | "unavailable";

export interface LbOperatorApprovalGrant {
  account: Address;
  chainId: number;
  operator: Address;
  pair: Address;
}

export interface LbOperatorApprovalObservation extends LbOperatorApprovalGrant {
  approved: boolean;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function observationMatchesGrant(
  observation: LbOperatorApprovalObservation | null,
  grant: LbOperatorApprovalGrant | null
): observation is LbOperatorApprovalObservation {
  return observation !== null && grant !== null &&
    observation.chainId === grant.chainId &&
    sameAddress(observation.account, grant.account) &&
    sameAddress(observation.pair, grant.pair) &&
    sameAddress(observation.operator, grant.operator);
}

export function classifyLbOperatorApproval(input: {
  approvedGrants: readonly LbOperatorApprovalGrant[];
  current: LbOperatorApprovalGrant | null;
  observation: LbOperatorApprovalObservation | null;
}): LbOperatorApprovalState {
  const { approvedGrants, current, observation } = input;
  if (current === null || !observationMatchesGrant(observation, current)) return "unavailable";
  if (observation.approved) return "approved";
  const relevantGrants = approvedGrants.filter((grant) =>
    grant.chainId === current.chainId && sameAddress(grant.account, current.account)
  );
  if (relevantGrants.some((grant) =>
    sameAddress(grant.pair, current.pair) && sameAddress(grant.operator, current.operator)
  )) return "externally-revoked";
  if (relevantGrants.some((grant) => sameAddress(grant.pair, current.pair))) return "wrong-operator";
  if (relevantGrants.some((grant) => !sameAddress(grant.pair, current.pair))) return "wrong-pair";
  return "unapproved";
}

export function lbOperatorApprovalStateLabel(state: LbOperatorApprovalState): string {
  switch (state) {
    case "approved":
      return "Approved for this exact pair and operator";
    case "unapproved":
      return "Not approved";
    case "externally-revoked":
      return "Externally revoked since the last approved read";
    case "wrong-pair":
      return "Prior approval was for a different LBPair";
    case "wrong-operator":
      return "Prior approval was for a different operator";
    case "unavailable":
      return "Live approval state unavailable";
  }
}
