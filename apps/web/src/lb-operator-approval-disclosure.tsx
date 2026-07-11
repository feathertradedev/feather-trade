import type { Address } from "viem";

import {
  classifyLbOperatorApproval,
  lbOperatorApprovalStateLabel,
  type LbOperatorApprovalGrant,
  type LbOperatorApprovalObservation
} from "./lb-operator-approval";

export function LbOperatorApprovalDisclosure({
  account,
  approvedGrants,
  chainId,
  networkName,
  observation,
  operator,
  pair
}: {
  account: Address | null;
  approvedGrants: readonly LbOperatorApprovalGrant[];
  chainId: number;
  networkName: string;
  observation: LbOperatorApprovalObservation | null;
  operator: Address;
  pair: Address | null;
}) {
  const current = account === null || pair === null
    ? null
    : { account, chainId, operator, pair };
  const state = classifyLbOperatorApproval({ approvedGrants, current, observation });
  const relevantGrants = account === null || pair === null
    ? []
    : approvedGrants.filter((grant) =>
        grant.chainId === chainId && grant.account.toLowerCase() === account.toLowerCase()
      );
  const mismatchedGrant = state === "wrong-operator"
    ? relevantGrants.find((grant) => grant.pair.toLowerCase() === pair?.toLowerCase() && grant.operator.toLowerCase() !== operator.toLowerCase())
    : state === "wrong-pair"
      ? relevantGrants.find((grant) => grant.pair.toLowerCase() !== pair?.toLowerCase())
      : undefined;
  const stateDetail = state === "approved"
    ? "The current on-chain read is true for this exact owner, LBPair, and router/operator."
    : state === "externally-revoked"
      ? "This exact owner, LBPair, and operator was previously observed approved, but the current on-chain read is false. A fresh approval is required."
      : state === "wrong-pair"
        ? `An observed approval belongs to a different LBPair (${mismatchedGrant?.pair ?? "unknown"}); it cannot authorize this pair.`
        : state === "wrong-operator"
          ? `An observed approval belongs to a different operator (${mismatchedGrant?.operator ?? "unknown"}); it cannot authorize the current router.`
          : state === "unapproved"
            ? "The current on-chain read is false and no matching approved grant has been observed."
            : "A current on-chain read for the exact owner, pair, and operator is not available; withdrawal stays blocked.";
  return (
    <section
      className="approval-disclosure"
      id="remove-lb-approval-details"
      aria-label="LB pair operator approval details"
      data-approval-state={state}
      data-testid="lb-operator-approval-disclosure"
    >
      <strong>Persistent pair-wide LB operator approval</strong>
      <p data-testid="lb-operator-approval-state"><strong>{lbOperatorApprovalStateLabel(state)}</strong> · {stateDetail}</p>
      <dl>
        <div><dt>Token / asset</dt><dd>ERC-1155 LB tokens issued by this exact LBPair</dd></div>
        <div><dt>LBPair token contract</dt><dd><code className="approval-address" data-testid="remove-lb-approval-details-pair">{pair ?? "not selected"}</code></dd></div>
        <div><dt>Router / operator</dt><dd><code className="approval-address" data-testid="remove-lb-approval-details-spender">{operator}</code></dd></div>
        <div><dt>Owner checked</dt><dd><code className="approval-address">{account ?? "wallet not connected"}</code></dd></div>
        <div><dt>Network</dt><dd>{networkName} · chain {chainId}</dd></div>
        <div><dt>Current state (live on-chain read)</dt><dd>{lbOperatorApprovalStateLabel(state)}</dd></div>
        <div><dt>Requested</dt><dd>Persistent pair-wide operator access for the current router</dd></div>
        <div><dt>Scope</dt><dd>Every LB token ID held now or later by this owner in this exact LBPair ERC-1155 contract. It is not limited to the selected bins or this withdrawal.</dd></div>
        <div><dt>Persistence</dt><dd>Remains on-chain for this exact pair and operator until explicitly revoked. Disconnecting the wallet or this site does not revoke it.</dd></div>
        <div><dt>Manual / external revocation</dt><dd>On {networkName} (chain {chainId}), use a trusted explorer or contract interface to call <code>approveForAll({operator}, false)</code> on LBPair <code>{pair ?? "not selected"}</code>. This is an on-chain transaction and costs gas. Then verify <code>isApprovedForAll({account ?? "owner"}, {operator})</code> returns false on that same chain.</dd></div>
        <div><dt>In-app revoke</dt><dd>Not offered in this release; tracked as P1 follow-on #42.</dd></div>
      </dl>
    </section>
  );
}
