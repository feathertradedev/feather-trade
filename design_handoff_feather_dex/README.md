# Handoff: Feather Trade — DEX brand + app UI (Quiet Carbon)

## Overview
Feather Trade is a DEX on Robinhood Chain modeled functionally on Meteora's DLMM (Dynamic Liquidity Market Maker): concentrated liquidity in discrete price bins, dynamic fees, and Spot/Curve/Bid-Ask deposit strategies. This package covers the locked brand direction ("Quiet Carbon"), the app screens (pools, pool detail, position detail, withdraw, single-sided deposit, swap), the marketing landing page, and brand assets.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code to copy directly**. The task is to recreate these designs in the target codebase's environment (React/Next.js, or whatever the team chooses) using its established patterns and libraries. If no frontend exists yet, pick the stack that best fits a real-time DEX frontend (e.g. React + a websocket data layer + a charting lib).

`Feather Trade — Brand Directions.dc.html` is a design-exploration canvas: it contains multiple iteration "turns." **Only these are canonical:**
- Turn 3 (ids `3a`, `3b`) — pool detail + pools home
- Turn 4 (`4a`, `4b`, `4c`) — position detail, withdraw, single-sided add
- Turn 5 (`5a`, `5d`) — landing page, brand board
- Turn 6 (`6a`, `6b`) — swap page, landing hero variant
Turns 1–2 are early explorations and superseded. Brand direction "1b Quiet Carbon" was chosen; all canonical screens implement it.

## Fidelity
**High-fidelity.** Colors, type, spacing, radii, and copy are final intent. Recreate pixel-perfectly. One caveat: charts (price bars, bin distribution) are static placeholder DIVs in the mocks — implement with a real charting layer but keep the visual language (rectangular bars, 2–3px gaps, tones below, single green active element).

## Design Tokens

### Color
| Token | Value | Use |
|---|---|---|
| `carbon` | `#0D0E0D` | page background, inset fields inside cards |
| `panel` | `#141614` | stat cards, content panels |
| `card` | `#161816` | elevated action cards (swap card, add-liquidity panel); add `inset 0 1px 0 rgba(233,236,231,.06)` top highlight |
| `bone` | `#E9ECE7` | primary text |
| `bone-bright` | `#F0F3EE` | primary button gradient start, logo gradient start |
| `ink-60` | `rgba(233,236,231,.6)` | secondary text |
| `ink-45` | `rgba(233,236,231,.45)` | tertiary text, inactive nav |
| `ink-40` | `rgba(233,236,231,.4)` | mono labels |
| `hairline` | `rgba(233,236,231,.08–.16)` | borders (08 section dividers, 10–12 card borders, 16–18 interactive outlines) |
| `green` (quiet green) | `oklch(72% 0.14 150)` ≈ `#4AC57C` | positive deltas, active bin, live dots, links, in-range status |
| `green-dim` | `#5E6B5D` | inactive strategy-shape bars, one-token bin side |
| `green-darker` | `#39413A`, `#2A2F2A`, `#232723` | chart bars scale-down tones |
| `rh-green` | `#00C805` | **glows only** — `rgba(0,200,5,.06–.14)` radial gradients + box-shadow glows. Never fills > 2% of a surface |
| `warn` | `#D9A94C` on `rgba(200,140,0,.08)` bg + `rgba(220,170,60,.25)` border | out-of-range alerts |

### Typography
- **UI: Schibsted Grotesk** (Google Fonts) — 400 body, 500 headings/values, 600 buttons. Tight tracking on large sizes (`-.01em` to `-.025em`).
- **Data/labels: IBM Plex Mono** 400 — all-caps section labels at 9px with `.12–.18em` letter-spacing, numeric metadata, addresses. (In-app minimum ~10–11px equivalents at 1:1 scale; the mocks are drawn at ~0.8 desktop scale, scale type up ~1.25× for production.)
- Wordmark: "feather" always lowercase, Schibsted Grotesk 500.

### Spacing & radius
- Card padding 16–18px; page gutter 24px (app), 40px (landing).
- Radii: inset fields **10px**, panels/cards **12–16px**, pills/chips **fully rounded**, primary buttons **10px** (app) / **22px pill** (landing).
- Grid gaps: 10px (stat rows), 14px (main columns).

### Buttons & controls
- **Primary**: `linear-gradient(180deg,#F0F3EE,#D6DCD3)`, text `#0D0E0D`, weight 600. Never green.
- **Secondary**: transparent, `1px solid rgba(233,236,231,.16–.18)`, text ink-60/75.
- **Chips**: mono 9–10px, hairline border, fully rounded, `white-space:nowrap`.
- **Live/status dot**: 5–6px circle in quiet green + label.
- **Wallet pill**: card bg, hairline border, green dot + truncated address (`7xKq…3fLm` pattern).
- **Active nav**: bone text + `1.5px` quiet-green bottom border; inactive = ink-45.

### Logo
Mark = "quill": a leaf/lens (square with `border-radius: 0 100%`, i.e. sharp TL+BR corners, fully-round TR+BL), filled `linear-gradient(135deg, #F0F3EE 0%, #AEB8AC 60%, #7E8A7D 100%)`, sliced along its long axis by a carbon (or transparent) line ~2.6% of its width, rotated 45°. Transparent PNGs at 512/256/128/64 in `assets/logo/`. Clearspace = ½ mark width; min size 20px. Robinhood `#00C805` reserved for glow tints only.

## Screens / Views

### 1. Pools home (`3b`)
- Top nav: logo lockup, Swap / **Pools** (active) / Portfolio, wallet pill right.
- Page header on faint green radial glow: H1 "Liquidity pools" 24/500, sub 12 ink-50.
- Filter row: search input (pill, card bg), category chips: **All** (selected = bone bg, carbon text) / DLMM / Dynamic / Stables; right-aligned `sort: Volume 24H ▾`.
- Table: mono 9px header row (POOL / TVL / VOL 24H / FEES 24H / 24H FEE/TVL), then one panel-bg row per pool, grid `2fr 1fr 1fr 1fr 1fr 84px`. Pool cell: two overlapping 22px token circles, pair name 500, type chip. Fee/TVL value in quiet green. Row action: "Deposit" secondary pill 28px.
- Data contract per row: pair, poolType, tvlUsd, volume24hUsd, fees24hUsd, feeTvl24hPct.

### 2. DLMM pool detail (`3a`)
- Pair header: overlapping token avatars (34px), pair 22/500, chips `bin step 25` + `fee 0.20%`, right block: price 22/500 + 24h delta (green) + mono unit label. All `nowrap`.
- Stat cards ×4 (panel bg, 12px radius): TVL (+ per-token breakdown line, e.g. `1.84M FTHR · 5,208 SOL`), VOLUME 24H (+ swap count), FEES 24H (+ current dynamic fee), 24H FEE/TVL (green value + `≈ APR` line; card gets faint green top glow).
- Fee-detail chip row: `base fee 0.20%` `max fee 10.00%` `protocol fee 5% of dynamic` `bin step 25 bps`; right: external chart links (Birdeye · DEXScreener · GeckoTerminal).
- Main grid `1fr 320px`:
  - **Liquidity card**: tab row (Liquidity active / Volume / TVL / Fees), legend (SOL side / FTHR side / active bin), bin bar chart — left-of-active bars in `#5E6B5D` (opacity ramps toward active), right-of-active in `#39413A`, active bin in quiet green with `0 0 20px rgba(0,200,5,.25)` glow. X-axis mono price labels, active price in green. Footer row: "Current pool price" + value + mono market price + "in sync" green dot + right-aligned **Sync with market price** secondary pill. (Sync = align pool price to external oracle/market before deposits.)
  - **Your positions card**: header "Your positions · n", right green link "unclaimed $X — claim all". Rows (inset carbon bg, 10px radius), grid `1.5fr 1fr 1fr 1fr auto`: range 500 + mono meta (`27 bins · spot`), VALUE, FEES (green), STATUS (green dot "in range" / dim dot "out of range"), actions **Claim** (primary sm, 26px) + **Withdraw ▾** (secondary sm).
  - **Add-liquidity panel** (card bg, right column): tabs Add (active, inset bg) / Withdraw / Swap. Two deposit fields (inset bg: mono label DEPOSIT + balance/max, value 17/500, token tag). Auto-fill note `auto-filled 50:50`. VOLATILITY STRATEGY: 3 selectable tiles with bar-shape glyphs — Spot (flat bars), Curve (bell), Bid-Ask (U); selected = green border + green bars. PRICE RANGE label + `27 bins · max 69`; range slider: track inset bg, selected span `rgba(0,200,5,.14)`, two 4px bone handles, 1.5px green current-price marker. MIN/MAX value boxes. Cost block (inset bg, mono 9): `position rent 0.0574 SOL · refundable` (green "refundable"), `bin arrays 0.0684 SOL · non-refundable`, underlined `show cost details`. Primary button **Add liquidity**.

### 3. Position detail (`4a`)
- Header: back link "← FTHR–SOL pool", title "Position 421.40 – 438.10", chip `27 bins · spot`, green "in range" dot, right mono position address.
- P&L stat cards ×4: NET DEPOSITS (+ deposit/withdrawal count), CURRENT VALUE (+ "excl. unclaimed fees"), FEES EARNED (+ claimed/open split), NET P&L (green, + % vs deposits, glow card).
- Main grid `1fr 320px`:
  - **Your liquidity in pool** chart: legend pool (`#2A2F2A`) / your position (quiet green at ~.7–.95 alpha ramp) / active bin (full green + glow). Bars outside the position range are pool-toned; inside are green-toned. Axis: min/max labels in dim green, active price in green.
  - Below chart, two inset boxes: CURRENT BALANCE (per-token amounts + $ values) and UNCLAIMED FEES (per-token amounts + $ values).
  - Right column: ACTIONS card — **Claim fees · $204.80** (primary), Add liquidity / Withdraw (secondary), "Withdraw & close position" (dimmer secondary), mono note "closing refunds 0.0574 SOL rent". HISTORY card — rows: type / $ amount (claims in green) / mono date.

### 4. Withdraw flow (`4b`)
- Out-of-range alert banner (warn tokens): "Position is out of range — price moved above 438.10. It is no longer earning fees."
- Card: tabs (Withdraw active). AMOUNT mono label + "of $X position". Big % value 26/500 + ≈$ value. Slider: 4px track, filled left span in green, 16px bone thumb. Quick chips 25/50/75/Max (selected = green border). "You receive" inset box: per-token amounts + `+ unclaimed fees $X` (green). Two exits: **Withdraw liquidity** (primary) and **Withdraw all & close position** (secondary) + mono note "closing claims all fees + refunds 0.0574 SOL rent".

### 5. Single-sided deposit (`4c`)
- Add tab. First deposit field normal (FTHR); second (SOL) at 45% opacity with value 0.
- Green info note (green-tinted bg + border): "Single-sided: your range sits above the active bin, so only FTHR is needed. It converts to SOL as price rises through your bins."
- Range slider with selected span entirely right of the green current-price marker. `34 bins · max 69`. MIN/MAX boxes. Primary **Add liquidity**.
- Logic: range entirely above active price → base-token only; entirely below → quote-token only; straddling → both.

### 6. Swap page (`6a`)
- Nav (Swap active). Grid `1fr 340px`.
- Chart card: pair avatars + "FTHR / SOL" + price + green delta; timeframe chips 1H (active, inset bg) / 4H / 1D / 1W. Price bars ramp from `#232723` up through green-grays to a final quiet-green bar with glow; mono time axis ending in green "now".
- Route card: mono ROUTE label + "best of 4 quotes"; node chips joined by hairlines: SOL → `FTHR–SOL DLMM · 82%` (green-bordered) + `via USDC · 18%` → FTHR.
- Swap card (card bg): header "Swap" + `slippage 0.5% ▾`; YOU PAY inset field (balance, amount 20/500, token selector pill with 14px token circle, 25/50/MAX chips); circular ⇅ swap-direction button overlapping the two fields (30px, card bg, hairline border); YOU RECEIVE field; detail rows mono 10px: rate / price impact (green) / min received / network fee; primary **Swap**.

### 7. Landing page (`5a`, hero variant `6b`)
- Nav: lockup, Swap/Pools/Docs, **Launch app** primary pill right.
- Hero (5a centered): mono kicker `THE FEATHERWEIGHT DEX · ROBINHOOD CHAIN` (.3em tracking), H1 "Weightless liquidity." 64/500/1.04/-.025em, sub 15/1.6 ink-55, CTAs Launch app (primary pill) + Read the docs (secondary pill). Faint green radial glow behind. Stats bar: bordered pill-box, 4 cells divided by hairlines: TVL / VOLUME 24H / POOLS / LP FEES 24H (green).
- Alternative hero (6b): split `1fr 380px` — copy left (stats as inline mono row), functional swap card right with `0 30px 80px rgba(0,0,0,.5)` drop + inset highlight.
- Pillars ×3 (panel cards, 16px radius): bin-bars glyph → "Liquidity in bins"; mono `0.20% → 2.41%` (green) → "Fees that surge with volatility"; green-ringed chain dot → "Native to Robinhood Chain". Title 17/500, body 12.5/1.6 ink-50.
- LP band: kicker FOR LIQUIDITY PROVIDERS, "Three strategies. One slider.", the three strategy tiles (Spot selected).
- Footer: small lockup, Docs/Security/X/Discord, mono "engineered on robinhood chain · 2026".

## Interactions & Behavior
- **Hovers** (not drawn; follow tokens): primary buttons brighten to flat `#F0F3EE`; secondary borders → `.28` alpha; table rows lift to `#171917`; nav links → bone; chips border-brighten.
- **Navigation**: pools row / Deposit → pool detail; position row → position detail; back links as shown. Tabs (Add/Withdraw/Swap, chart tabs, timeframes) switch in place.
- **Add liquidity**: token amounts auto-fill to the strategy ratio (editable); strategy tile selection re-renders projected distribution; range handles snap to bin boundaries and update bin count (cap 69 — clamp + show count); cost block recalculates rent before submit; out-of-sync pool price → warn before deposit, offer Sync.
- **Withdraw**: slider ↔ quick chips two-way; "you receive" updates live; close variant claims fees + refunds rent.
- **Alerts**: out-of-range banner on affected positions (warn tokens).
- **Loading**: skeleton rows in panel bg; numbers settle without layout shift (tabular-lining figures for mono).
- **Motion**: minimal. 150–200ms ease-out on hovers/tab switches; glow elements static. One glow per view maximum.

## State Management
- Wallet session (address, connected chain).
- Pools list: filters (category), sort key, search query, paginated pool rows.
- Pool detail: pool metadata (bin step, base/max/dynamic fee, protocol fee), bin distribution (per-bin token X/Y amounts, active bin id), price + external market price, user positions for pool.
- Position: range (minBin/maxBin), strategy, per-token balances, unclaimed fees per token, history (deposits/withdrawals/claims), P&L derivation: currentValue + feesEarned − netDeposits.
- Add-liquidity form: amounts, strategy, range, derived bin count, derived rent costs, single-sided detection.
- Swap form: pay/receive amounts, token selection, slippage, quote (rate, impact, min received, route legs).
- Real-time: prices, active bin, and stats should stream (websocket/polling).

## Assets
`assets/` contains: transparent logo marks (512/256/128/64 PNG), X banners (1500×500), pfp (400×400). All generated from the HTML mocks — no third-party assets. Fonts are Google Fonts (Schibsted Grotesk, IBM Plex Mono).

## Files
- `Feather Trade — Brand Directions.dc.html` — full design canvas (open in a browser; canonical turns 3–6, see above)
- `assets/logo/feather-mark-{512,256,128,64}.png`
- `assets/feather-x-banner.png`, `assets/feather-x-banner-simple.png`, `assets/feather-pfp.png`
- `screenshots/` — reference PNGs of each canonical screen (named by canvas id: 3a-pool-detail, 3b-pools-home, 4a-position-detail, 4b-withdraw, 4c-single-sided, 5a-landing, 5d-brand-board, 6a-swap, 6b-landing-hero). Captured at ~0.8 scale; the HTML canvas is the source of truth for exact values.
