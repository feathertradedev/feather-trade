import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAddress } from "viem";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), logLevel: "error", server: { middlewareMode: true } });

try {
  const { classifyLbOperatorApproval, lbOperatorApprovalStateLabel, observationMatchesGrant } = await server.ssrLoadModule("/src/lb-operator-approval.ts");
  const { LbOperatorApprovalDisclosure } = await server.ssrLoadModule("/src/lb-operator-approval-disclosure.tsx");
  const account = getAddress("0x1000000000000000000000000000000000000001");
  const pair = getAddress("0x2000000000000000000000000000000000000002");
  const otherPair = getAddress("0x3000000000000000000000000000000000000003");
  const operator = getAddress("0x4000000000000000000000000000000000000004");
  const otherOperator = getAddress("0x5000000000000000000000000000000000000005");
  const current = { account, chainId: 31337, operator, pair };

  assert.equal(classifyLbOperatorApproval({ approvedGrants: [], current, observation: { ...current, approved: true } }), "approved");
  assert.equal(classifyLbOperatorApproval({ approvedGrants: [], current, observation: { ...current, approved: false } }), "unapproved");
  assert.equal(classifyLbOperatorApproval({ approvedGrants: [current], current, observation: { ...current, approved: false } }), "externally-revoked");
  assert.equal(classifyLbOperatorApproval({ approvedGrants: [current], current: { ...current, pair: otherPair }, observation: { ...current, pair: otherPair, approved: false } }), "wrong-pair");
  assert.equal(classifyLbOperatorApproval({ approvedGrants: [current], current: { ...current, operator: otherOperator }, observation: { ...current, operator: otherOperator, approved: false } }), "wrong-operator");
  assert.equal(classifyLbOperatorApproval({ approvedGrants: [current], current, observation: null }), "unavailable");
  assert.equal(classifyLbOperatorApproval({ approvedGrants: [current], current, observation: { ...current, pair: otherPair, approved: true } }), "unavailable");
  assert.equal(
    classifyLbOperatorApproval({
      approvedGrants: [{ ...current, pair: otherPair }, { ...current, operator: otherOperator }, current],
      current,
      observation: { ...current, approved: false }
    }),
    "externally-revoked",
    "an exact prior grant must outrank overlapping wrong-pair and wrong-operator history"
  );
  assert.equal(
    classifyLbOperatorApproval({
      approvedGrants: [{ ...current, pair: otherPair }, { ...current, operator: otherOperator }],
      current,
      observation: { ...current, approved: false }
    }),
    "wrong-operator",
    "a same-pair operator mismatch must outrank unrelated pair history"
  );
  assert.equal(observationMatchesGrant({ ...current, approved: true }, current), true);

  const wrongOperatorStateMarkup = renderToStaticMarkup(createElement(LbOperatorApprovalDisclosure, {
    account,
    approvedGrants: [{ ...current, pair: otherPair }, { ...current, operator: otherOperator }],
    chainId: current.chainId,
    networkName: "Test Network",
    observation: { ...current, approved: false },
    operator,
    pair
  }));
  assert.match(wrongOperatorStateMarkup, /data-approval-state="wrong-operator"/);
  assert.match(wrongOperatorStateMarkup, /Prior approval was for a different operator/);
  assert.match(wrongOperatorStateMarkup, new RegExp(otherOperator, "i"));
  assert.match(wrongOperatorStateMarkup, new RegExp(operator, "i"));
  assert.doesNotMatch(wrongOperatorStateMarkup, /Prior approval was for a different LBPair/);
  assert.match(wrongOperatorStateMarkup, /Test Network · chain 31337/);

  for (const state of ["approved", "unapproved", "externally-revoked", "wrong-pair", "wrong-operator", "unavailable"]) {
    assert.ok(lbOperatorApprovalStateLabel(state).length > 0, `${state} must have user-facing copy`);
  }
} finally {
  await server.close();
}

console.log("lb operator approval tests passed");
