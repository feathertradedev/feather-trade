# Feather public docs sync tracker

This file is repository-only and is never copied into the public web artifact. It maps each public page to the product behavior it documents. `target` means the page describes accepted Wave 4 behavior that still needs rendered-product verification. `stub` means builder content is intentionally waiting for verified mainnet contracts.

| Slug | Wave 4 stories | Application route or control | Status | Owner | Last verified | Screenshot |
| --- | --- | --- | --- | --- | --- | --- |
| welcome | ON-01 | `/` | target | docs-team | 2026-07-14 | none |
| overview/liquidity-book | LP-14, PM-04 | pool and portfolio concepts | target | docs-team | 2026-07-14 | none |
| overview/why-feather | ON-01, PW-09 | landing and pool workspace | target | docs-team | 2026-07-14 | none |
| overview/risks | ON-01, PC-06, LP-03 | cross-product | target | docs-team | 2026-07-14 | none |
| overview/glossary | PW-02, LP-05, PM-07 | cross-product | target | docs-team | 2026-07-14 | none |
| getting-started/before-you-begin | ON-01, ON-08 | landing and wallet | target | docs-team | 2026-07-14 | none |
| getting-started/wallet-network | ON-02, ON-04, ON-08 | wallet panel | target | docs-team | 2026-07-14 | none |
| getting-started/connect | ON-02-ON-07 | wallet panel | target | docs-team | 2026-07-14 | none |
| getting-started/tokens | TK-01-TK-05 | token selectors | target | docs-team | 2026-07-14 | none |
| getting-started/first-pool | DS-09, PW-01-PW-03 | `/pools/:poolAddress` | target | docs-team | 2026-07-14 | none |
| pools/discover | DS-01-DS-10 | `/pools` | target | docs-team | 2026-07-14 | none |
| pools/workspace | PW-01-PW-12 | `/pools/:poolAddress` | target | docs-team | 2026-07-14 | none |
| pools/charts | PW-04, PW-06 | pool chart and distribution | target | docs-team | 2026-07-14 | none |
| pools/swap | SW-01-SW-13 | pool Swap rail | target | docs-team | 2026-07-14 | none |
| pools/swap-settings | SW-03-SW-05 | swap settings | target | docs-team | 2026-07-14 | none |
| pools/create | PC-01-PC-11 | Discover Create Pool | target | docs-team | 2026-07-14 | none |
| pools/empty-pools | PW-11, PC-08-PC-10 | empty pool workspace | target | docs-team | 2026-07-14 | none |
| pools/duplicate-pools | DS-06, PC-07, SW-11 | pool selection and creation | target | docs-team | 2026-07-14 | none |
| liquidity/primer | LP-01, PM-04 | Create Position and Portfolio | target | docs-team | 2026-07-14 | none |
| liquidity/ranges-bins | LP-05-LP-07 | range controls | target | docs-team | 2026-07-14 | none |
| liquidity/strategies | LP-02-LP-03 | strategy picker | target | docs-team | 2026-07-14 | none |
| liquidity/one-sided | LP-04, LP-09 | position composition | target | docs-team | 2026-07-14 | none |
| liquidity/create-add | LP-01-LP-14 | Create Position and Add More | target | docs-team | 2026-07-14 | none |
| liquidity/composition-fees | LP-16 | position review | target | docs-team | 2026-07-14 | none |
| liquidity/manage | PM-01-PM-05 | `/portfolio` and detail | target | docs-team | 2026-07-14 | none |
| liquidity/withdraw-exit | PM-06-PM-13 | position Withdraw and Exit | target | docs-team | 2026-07-14 | none |
| liquidity/multi-transaction-exits | PM-16 | batched full exit | target | docs-team | 2026-07-14 | none |
| liquidity/fees-pnl | PM-01-PM-04 | portfolio accounting | target | docs-team | 2026-07-14 | none |
| liquidity/out-of-range | LP-15, PM-01, PM-10 | position detail | target | docs-team | 2026-07-14 | none |
| safety/erc20-approvals | TK-06-TK-07 | approval review | target | docs-team | 2026-07-14 | none |
| safety/lb-operator-approvals | TK-08, PM-11 | withdrawal approval | target | docs-team | 2026-07-14 | none |
| safety/eth-weth | TK-09, SW-13, PM-10 | asset mode control | target | docs-team | 2026-07-14 | none |
| safety/gas | ON-08, LP-10 | network fee review | target | docs-team | 2026-07-14 | none |
| safety/transaction-review | RI-08 | every write review | target | docs-team | 2026-07-14 | none |
| safety/transaction-lifecycle | RI-06-RI-07 | transaction journal | target | docs-team | 2026-07-14 | none |
| safety/rejected-reverted | SW-09, LP-13, RI-07 | transaction journal | target | docs-team | 2026-07-14 | none |
| safety/incomplete-information | DS-08, PW-12, RI-04-RI-05 | shared load states | target | docs-team | 2026-07-14 | none |
| safety/token-hook-warnings | TK-03, TK-11, PW-01 | token and pool readiness | target | docs-team | 2026-07-14 | none |
| safety/wallet-network | ON-03-ON-05 | wallet panel | target | docs-team | 2026-07-14 | none |
| safety/vulnerability | RI-10, SEC | configured Security link | target | docs-team | 2026-07-14 | none |
| contracts/architecture | CON | public contract surface | stub | protocol-team | 2026-07-14 | none |
| contracts/mainnet-deployments | G-03, G-09 | selected mainnet manifest | stub | protocol-team | 2026-07-14 | none |
| contracts/factory | PC-02-PC-07 | LBFactory | stub | protocol-team | 2026-07-14 | none |
| contracts/pair-token | LP-14, PM-04 | LBPair and LBToken | stub | protocol-team | 2026-07-14 | none |
| contracts/router | SW-07, LP-10, PM-08 | LBRouter | stub | protocol-team | 2026-07-14 | none |
| contracts/quoter | SW-03-SW-07 | LBQuoter | stub | protocol-team | 2026-07-14 | none |
| contracts/integration-recipes | RI-08 | direct contract patterns | stub | protocol-team | 2026-07-14 | none |
| contracts/events-errors | PM-12, PM-14 | receipts and events | stub | protocol-team | 2026-07-14 | none |
| contracts/safety-checklist | RI-07-RI-10 | integration boundary | stub | protocol-team | 2026-07-14 | none |

## Screenshot policy

Only screenshots captured from released product behavior may be added. Every screenshot must record desktop or mobile coverage, the tested application commit, and the date it was compared with the current page. Target pages use diagrams or text until the matching interface exists.
