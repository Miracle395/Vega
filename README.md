# Vega

**Vega is where you trade with an execution edge.**

Vega is a mobile first trading terminal for Sui, built entirely on **DeepBook V3**. Vega unifies spot execution and margin (borrow, supply, earn) in a single interface, so traders can route, leverage and earn yield without leaving the app or touching a second protocol.

Live app: [vegaxyz.vercel.app](https://vegaxyz.vercel.app)
Landing: [vegaxyz.vercel.app/home](https://vegaxyz.vercel.app/home)

Repo: [github.com/Miracle395/Vega](https://github.com/Miracle395/Vega)
Demo video: *coming soon*

---

## What Vega does

Most DEX terminals stop at spot. 
Vega goes further by building **two DeepBook primitives into one product**:

### Spot Trading
- Live order routing and pricing sourced directly from the **DeepBook V3 indexer** 
- TWAP order support and execution slice breakdown for large orders.
- Instant market data via DeepBook + CoinGecko for reference pricing.
- Mobile first orderbook and trade UX, designed to feel native on a phone.

### Margin: Earn, Borrow, Supply.
- **Supply** DBUSDC or SUI to a DeepBook powered lending pool and earn yield from borrowers.
- **Borrow** against your supplied collateral with up to **5x leverage.**
- Instant **pool health**, **utilization rate** and **liquidation threshold** tracking per market.
- Per market risk parameters (min borrow/supply, supply caps, liquidation ratio) pulled live.

Both spot and margin sit on the same DeepBook liquidity layer, Vega doesn't fragment liquidity across separate AMMs or isolated lending markets.

> Vega does not implement DeepBook Predict : prediction markets are handled by our sister product, **Slete**.

---

## Screenshots

| Borrow | Supply | Landing |
|---|---|---|
| Live SUI borrow market against DBUSDC collateral, 5x max leverage, real-time pool health | DBUSDC supply market with live APY, total supplied, and supply cap | Mint-green/black brand identity, built-with partner strip |

---

## Tech Stack

Vega is deliberately framework free; vanilla HTML, CSS and JavaScript, no React/Vue/build step.

- **Chain:** Sui (Testnet)
- **Liquidity & Margin Engine:** DeepBook V3 (Spot + Margin)
- **RPC:** Tatum RPC, Sui Fullnode RPC.
- **Pricing:** DeepBook indexer, CoinGecko.
- **Frontend:** Vanilla JS, CSS (mint green `#d8f8d8` + black design system), Space Grotesk / Inter.
- **Deployment:** Vercel.

---

## Built With

| | | | |
|---|---|---|---|
| Sui Network | DeepBook V3 | Mysten Labs | Tatum RPC |

Submitted to **Sui Overflow 2026** : DeepBook track.

---

## Architecture notes

- All market data (rates, utilization, liquidity, caps) is fetched live from DeepBook, Vega has been built with **zero hardcoded or demo data**.
- Borrow and supply markets are rendered per asset (currently DBUSDC and SUI) with independent risk parameters.
- Post trade UX includes onchain confirmation, balance refresh, and a shareable trade/success card.

---

## Roadmap 

- [ ] Mainnet deployment
- [ ] Additional collateral assets beyond DBUSDC/SUI
- [ ] Cross-margin across spot and lending positions
- [ ] Expanded market pairs beyond BTC/USDC-class assets

---

## Team

Built solo by [@DomainGenius2](https://x.com/DomainGenius2) for Sui Overflow 2026.
