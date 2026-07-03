# Payments — how RugRadar charges per call (x402 / A2MCP)

RugRadar is listed on the OKX.AI marketplace as an **A2MCP** service (Agent-to-MCP:
a machine-callable API, charged per call, settled instantly). This document explains
exactly how the payment layer works and — importantly — **which part RugRadar
implements vs. which part the OKX payment infrastructure handles.**

- **Marketplace identity:** OKX.AI Agent **#3518** (X Layer, chainIndex 196)
- **Live endpoint:** `https://rugradar-3wka.onrender.com/assess`
- **Price:** `0.01 USDT` per call
- **Pay-to:** the provider's Agentic Wallet (`0x60a1527c…4eca`)

## The x402 flow, end to end

```
 Caller agent                RugRadar endpoint (/assess)         OKX payment rails
 ────────────                ───────────────────────────         ─────────────────
 1. POST /assess  ─────────▶  no payment header?
                             returns HTTP 402 + PAYMENT-REQUIRED
                             (the x402 "accepts" challenge)
 2. reads challenge  ◀────────
 3. pays 0.01 USDT  ───────────────────────────────────────────▶  onchainos payment pay
                                                                   signs the authorization,
                                                                   facilitator verifies + settles
 4. POST /assess  ─────────▶  payment header present?
    (+ X-PAYMENT)            runs assess_token_risk, returns 200
 5. risk verdict  ◀────────   { verdict, score, signals, … }
```

## What RugRadar's code implements (this repo)

RugRadar is a compliant **x402 resource server**:

1. **Issues the challenge.** On an unpaid request, `/assess` returns a real
   `HTTP 402` with the `PAYMENT-REQUIRED` header carrying the x402 `accepts`
   object (scheme `exact`, network `eip155:196`, amount, `payTo`, USDT asset, and
   the input schema for `token_address` / `chain`).
   → see [`src/x402.ts`](src/x402.ts) (`buildAccepts`, `buildChallenge`, `challengeHeader`)
2. **Gates on payment.** If the request carries an x402 payment header it serves
   the assessment; otherwise it returns the 402.
   → see [`src/http.ts`](src/http.ts) (the `/assess` route, `getPaymentHeader`, `paymentsActive`)

This is exactly what OKX's own validator checks — `onchainos agent x402-check`
returns `valid: true` against the live endpoint.

## What the OKX payment infrastructure handles (not re-implemented here)

- **Verification** of the caller's signed payment authorization.
- **On-chain settlement** of the `0.01 USDT` transfer to the provider wallet.

These are performed by the caller's `onchainos payment pay` step and OKX's x402
**facilitator** (the `task-402-pay` / settlement flow). This is the intended
A2MCP design: the resource server advertises the price and accepts the proof; a
facilitator settles it on X Layer. RugRadar therefore does **not** re-implement
on-chain verification/settlement — it relies on OKX's rails for that, which keeps
the endpoint stateless and lets settlement stay non-custodial.

> If independent verification/settlement were ever required (it is not, for the
> marketplace), it would be added as a facilitator call in front of `/assess`.

## Testnet ↔ mainnet (swappable)

The payment layer is fully config-driven (see [`.env.example`](.env.example)):

| Var | Purpose |
|---|---|
| `PAYMENTS_ENABLED` | Master switch for x402 gating on `/assess`. |
| `PAYMENT_MODE` | `testnet` / `mainnet` (X Layer). |
| `PAY_ASSET_SYMBOL` | `USDT` (or `USDG`) — the accepted payment token. |
| `PAY_TO` | Provider Agentic Wallet address (where fees land). |
| `PRICE_PER_CALL` | Fee, in the asset above (e.g. `0.01`). |

The **risk engine always reads mainnet chain data** (so real scam tokens exist to
assess) independently of which network the payment layer settles on.

## Pricing rationale

A2MCP is priced for **high volume, low unit cost**: `0.01 USDT` is trivially worth
it to avoid a rugged swap, and cheap enough that a trading agent can call it on
*every* candidate token. One prevented honeypot pays for thousands of calls.
