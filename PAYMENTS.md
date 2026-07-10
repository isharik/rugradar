# Payments — how RugRadar charges per call (x402 / A2MCP)

RugRadar is listed on the OKX.AI marketplace as an **A2MCP** service (Agent-to-MCP:
a machine-callable API, charged per call, settled instantly). This document explains
exactly how the payment layer works.

- **Marketplace identity:** OKX.AI Agent **#3518** (X Layer, chainIndex 196)
- **Live endpoint:** `https://rugradar-3wka.onrender.com/assess`
- **Price:** `0.01 USDT` per call
- **Pay-to:** the provider's Agentic Wallet (`0x60a1527c…4eca`)

## The x402 flow, end to end

```
 Caller agent                RugRadar (/assess, Express)          OKX hosted facilitator
 ────────────                ────────────────────────────         ───────────────────────
 1. POST /assess  ─────────▶  OKX SDK middleware: no payment
                              header? → returns HTTP 402 with
                              the x402 "accepts" challenge
 2. reads challenge  ◀────────
 3. signs payment  ───────────────────────────────────────────▶  (buyer-side signing,
    (via onchainos payment pay or an x402 client library)          not this repo)
 4. POST /assess  ─────────▶  OKX SDK middleware intercepts,
    (+ X-PAYMENT header)      calls OKX's hosted facilitator to
                              VERIFY the signed authorization
                              ─────────────────────────────────▶  verify(payload, requirements)
                              ◀─────────────────────────────────  valid / invalid
                              valid → request reaches our
                              handler → runs assess_token_risk
                              → SDK calls facilitator to SETTLE
                              ─────────────────────────────────▶  settle (on-chain transfer)
 5. risk verdict  ◀────────   HTTP 200 { verdict, score, … }
```

## What RugRadar's code implements (this repo)

RugRadar integrates the **official OKX Payment SDK** (`@okxweb3/x402-*`) as the
resource server for the paid route — it does not hand-roll the protocol:

- `src/http.ts` builds:
  - `OKXFacilitatorClient` (from `@okxweb3/x402-core`) — signs requests to OKX's
    hosted facilitator using `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`
    (HMAC-SHA256, the standard OKX API auth scheme).
  - `x402ResourceServer` registered with `ExactEvmScheme` (from
    `@okxweb3/x402-evm/exact/server`) for network `eip155:196` (X Layer).
  - `x402HTTPResourceServer` + `paymentMiddlewareFromHTTPServer` (from
    `@okxweb3/x402-express`) wired in front of `POST /assess` via Express.

Concretely, on every request to `/assess`, the SDK middleware:
1. **Issues the 402 challenge** (scheme `exact`, network `eip155:196`, price,
   `payTo`, asset) when no payment is attached.
2. **Verifies** a real signed payment authorization against OKX's hosted
   facilitator — an invalid, forged, or garbage `X-PAYMENT` header is rejected
   (the request never reaches our handler). This is the part a hand-rolled
   "is a header present?" check cannot do, and why RugRadar switched from a
   self-issued challenge to the official SDK.
3. **Settles** the payment on-chain (X Layer) after a successful call, via the
   same facilitator (`syncSettle: true` — the SDK waits for on-chain
   confirmation before the response is delivered).

Only after verification succeeds does `assessTokenRisk()` run and return the
structured verdict.

**Fail-closed by design:** if `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`
/ `PAY_TO` are not all configured, `/assess` returns `503 PAYMENTS_NOT_CONFIGURED`
— it never silently serves the paid resource for free, and a facilitator/auth
error at startup can't crash the process (health checks still pass).

## Getting OKX API credentials

`OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE` come from the
**OKX Developer Portal**: `https://web3.okx.com/onchain-os/dev-portal` — create
an API key scoped for Onchain OS / Agent Payments. Never commit real values;
keep them in `.env` (gitignored) or your host's secret environment variables
(e.g. Render's dashboard, `sync: false` in `render.yaml`).

## Testnet ↔ mainnet (swappable)

The payment layer is fully config-driven (see [`.env.example`](.env.example)):

| Var | Purpose |
|---|---|
| `PAYMENTS_ENABLED` | Master switch — must be `true` alongside valid OKX credentials. |
| `PAYMENT_MODE` | `testnet` / `mainnet` label (X Layer `eip155:196` is the only network the SDK currently supports). |
| `PAY_ASSET_SYMBOL` | `USDT` (USDT0) — the accepted payment token. |
| `PAY_TO` | Provider Agentic Wallet address (where fees land). |
| `PRICE_PER_CALL` | Fee, in the asset above (e.g. `0.01`). |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | OKX Developer Portal credentials for the facilitator. |

The **risk engine always reads mainnet chain data** (so real scam tokens exist to
assess) independently of the payment layer.

## Pricing rationale

A2MCP is priced for **high volume, low unit cost**: `0.01 USDT` is trivially worth
it to avoid a rugged swap, and cheap enough that a trading agent can call it on
*every* candidate token. One prevented honeypot pays for thousands of calls.
