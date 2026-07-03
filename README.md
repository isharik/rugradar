# RugRadar 🛡️

**An Agent-to-MCP (A2MCP) pre-transaction risk oracle for the OKX.AI Marketplace.**

Other AI agents call RugRadar **before** they swap into or approve a token, and get
back a structured risk verdict in a few seconds. One tool, one job: stop agents
from walking wallets into honeypots and rug pulls.

> Built for the OKX AI Genesis Hackathon. Payment is settled per-call via the OKX
> Payment SDK (A2MCP model). The risk engine is fully working today; the payment
> layer is config-swappable testnet↔mainnet.

---

## The use case

Autonomous agents now move real money on-chain. The single most expensive mistake
an agent can make is buying or approving a malicious token — a honeypot it can
never sell, a token whose owner can mint infinite supply, or one that drains
approvals. Humans check these things (sometimes). Agents usually don't, because
there's no clean, callable, machine-readable risk primitive.

**RugRadar is that primitive.** It's a marketplace service any agent can call:

```
agent  --(about to swap into 0xTOKEN)-->  RugRadar.assess_token_risk
                                              |
                                          verdict: AVOID (score 92)
                                              |
agent  --(aborts the swap)-->  human is never rugged
```

This maps directly to the hackathon's **Business Potential** and **Revenue Rocket**
tracks: it's a metered, high-frequency, pay-per-call service with obvious demand
from every other trading/wallet agent on the marketplace.

---

## The one tool: `assess_token_risk`

### Input

| Field           | Type              | Required | Description |
|-----------------|-------------------|----------|-------------|
| `token_address` | string (`0x…40`)  | yes      | Token/contract to assess. |
| `chain`         | number \| string  | no       | Chain id (`1`) or name (`ethereum`, `bsc`, `base`). Defaults to Ethereum. |

### Output (structured JSON)

| Field         | Description |
|---------------|-------------|
| `risk_score`  | `0` (safe) … `100` (maximally risky). |
| `verdict`     | `SAFE` \| `CAUTION` \| `HIGH_RISK` \| `AVOID`. |
| `confidence`  | `high` \| `medium` \| `low` — driven by how many data sources answered. |
| `signals[]`   | Per-check results, each `pass` / `warn` / `fail` / `not_available`. |
| `explanation` | One paragraph an agent can relay to a human, verbatim. |
| `sources[]`   | Which data sources were reachable at call time. |
| `notes[]`     | Non-fatal notes (e.g. a source that was skipped). |

### Signal checks (v1)

| Signal | Source(s) | Notes |
|---|---|---|
| Sellability / honeypot | honeypot.is (live sim), GoPlus | Dominant: if you can't sell it, it's `AVOID`. |
| Third-party risk rating | honeypot.is summary | Aggregated expert rating. |
| Buy/sell tax | honeypot.is, GoPlus | High sell tax = soft honeypot. |
| Mint authority | GoPlus | Can supply be inflated? |
| Liquidity present | honeypot.is, GoPlus | Is it actually tradeable? |
| Liquidity lock | GoPlus | Locked/burned LP vs. pullable. |
| Ownership renounced | GoPlus, public RPC | Owner privileges / take-back. |
| Top-10 holder concentration | GoPlus | Scored on **EOA** holders (contracts/pools excluded). |
| Malicious / drain patterns | GoPlus, honeypot.is | Blacklist, pausable, hidden owner, self-destruct, … |
| Verified source code | honeypot.is, GoPlus | Opaque code = caution. |
| Upgradeable proxy | GoPlus, honeypot.is | Logic can change post-deploy. |

Anything we can't source cleanly is reported `not_available` — **we never fake a
result**. Additional checks are stubbed for future versions rather than guessed.

---

## Example

**Request**

```json
{ "chain": 56, "token_address": "0x87230146E138d3F296a9a77e497A2A83012e9Bc5" }
```

**Response (abridged)**

```json
{
  "ok": true,
  "request": { "chain_id": 56, "chain_name": "BNB Smart Chain", "token_address": "0x8723…9bc5" },
  "token": { "name": "Squid Game", "symbol": "SQUID", "decimals": 18, "total_holders": 101591 },
  "risk_score": 50,
  "verdict": "HIGH_RISK",
  "confidence": "high",
  "signals": [
    { "id": "risk_rating", "status": "fail", "detail": "honeypot.is rates this HIGH risk (level 51)." },
    { "id": "open_source", "status": "warn", "detail": "Contract source is NOT verified — behaviour is opaque." },
    { "id": "proxy",       "status": "warn", "detail": "Upgradeable proxy — contract logic can change after deployment." }
  ],
  "explanation": "SQUID is HIGH RISK (risk 50/100). Proceed only if you fully understand the danger. Critical problems: third-party risk rating. Cautions: verified source code, upgradeable proxy. Confidence is high, based on 3 of 3 data sources reachable. This is automated risk information, not financial advice.",
  "sources": [
    { "name": "honeypot.is", "reachable": true },
    { "name": "public-rpc",  "reachable": true },
    { "name": "goplus",      "reachable": true }
  ]
}
```

Note this is a *current-state* read, not a lookup of "famous scams": SQUID's LP is
now locked and ownership renounced, so RugRadar doesn't over-claim `AVOID` — it
reports the real residual risk (unverified, upgradeable, high aggregate rating).

---

## Reliability by design

- **Stateless & idempotent** — output depends only on inputs + current chain state.
- **Graceful degradation** — every source is best-effort. If one is down, the call
  still succeeds with partial signals, lowered `confidence`, and a `note`. (This is
  real: GoPlus is edge-blocked from some networks and RugRadar keeps working.)
- **Strong input validation** — bad addresses/chains return a structured
  `INVALID_INPUT` / `UNSUPPORTED_CHAIN` error, never a crash.
- **Fast** — all sources are queried in parallel with a per-source timeout.

---

## Data sources (all free / keyless in v1)

| Source | Role | Key needed? |
|---|---|---|
| [honeypot.is](https://honeypot.is) | Primary — live sell-simulation, tax, liquidity, metadata | No |
| Public RPC (PublicNode / dRPC) | Secondary — on-chain reads (owner, code, supply) | No |
| [GoPlus Security](https://gopluslabs.io) | Enrichment — mint, LP lock, holders, malicious flags | No |

Risk data is always read from **mainnet** (so real scam tokens exist to assess),
independently of which network the *payment* layer uses.

---

## Run it locally

```bash
npm install
cp .env.example .env          # optional; everything works with defaults

npm run test:discriminate     # SAFE vs. scam discrimination proof
npm run test:mcp              # end-to-end MCP client handshake + tool call
npm run assess -- 1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48   # assess USDC
npm run find-scam            # find a current live scam token (demo helper)

npm run mcp                  # start the MCP server (stdio) for an agent to use
```

### Wire into an MCP agent (OpenClaw, Claude Code, etc.)

```jsonc
{
  "mcpServers": {
    "rugradar": {
      "command": "node",
      "args": ["--import", "tsx", "/absolute/path/to/rugradar/src/mcp.ts"]
    }
  }
}
```

(For production, `npm run build` and point at `dist/mcp.js`.)

---

## Switching testnet ↔ mainnet

The **risk engine** always reads mainnet chain data — nothing to switch there.

The **payment layer** (OKX Payment SDK, added in the payments phase) is fully
config-driven via `.env`:

```dotenv
PAYMENT_MODE=testnet     # build & test at ~$0 using X Layer testnet
# PAYMENT_MODE=mainnet   # flip one line to go live on X Layer mainnet
PRICE_PER_CALL=0.01      # what other agents pay per call
```

`src/config.ts` reads `PAYMENT_MODE` and selects the corresponding X Layer network
+ credentials. No code changes — flip the env var and restart.

---

## Pricing rationale

The A2MCP model is **per-call, no negotiation, instant settlement**. RugRadar is a
cheap check that prevents an expensive loss, so it's priced for **high volume, low
unit cost**:

- Default **`0.01` per call** — trivially worth it to avoid a rugged swap, low
  enough that a trading agent can call it on *every* candidate token without
  thinking about cost.
- Value is asymmetric: one prevented honeypot pays for thousands of calls.
- Volume is the moat — every wallet/trading/DeFi agent on the marketplace is a
  potential caller, which is exactly what the Revenue Rocket track rewards.

Tune via `PRICE_PER_CALL`. Sub-cent pricing is viable on X Layer thanks to low fees.

---

## Adding a chain

Add one entry to `CHAINS` in `src/config.ts` (id, name, aliases, public RPCs,
honeypot.is + GoPlus chain ids, explorer). Everything else is generic. BSC and Base
are already wired as proof.

---

## Roadmap (honestly scoped)

- v1 (this): Ethereum + BSC + Base; honeypot.is + RPC + GoPlus; the 11 signals above.
- Next: LP-age / deployer-history signals, approval-drain simulation, Solana support,
  response caching, and the OKX Payment SDK metering wrapper.

*RugRadar returns automated risk information, not financial advice.*
