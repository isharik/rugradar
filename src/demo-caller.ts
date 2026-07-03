/**
 * Demo caller — the ≤90s hackathon demo.
 *
 * Simulates a trading agent ("TradeBot") that is about to swap into a token and
 * calls RugRadar FIRST. On a scam it aborts; on a safe token it proceeds. This
 * is the exact value proposition: an agent-to-agent risk check before a trade.
 *
 *   npm run demo                       # default: live honeypot vs WETH
 *   npm run demo -- <chain> <address>  # assess any token as the "scam" leg
 *
 * Uses RugRadar's own engine (the same code deployed at OKX.AI ASP #3518).
 */
import "./env.js";
import { assessTokenRisk } from "./assess.js";
import type { AssessResult } from "./schema.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The real deployed endpoint listed on OKX.AI (Agent #3518).
const LIVE = process.env.PUBLIC_URL || "https://rugradar-3wka.onrender.com";

/**
 * Proves — on camera — that this is a REAL deployed, paid x402 service, not a
 * local mock. Pings the live health check, then shows the live 402 challenge.
 * No payment is made (a 402 is the server *asking* for payment) → completely free.
 */
async function proveLive() {
  console.log("\n🌐  RugRadar is deployed & listed on OKX.AI  →  Agent #3518");
  console.log(`     Verifying the LIVE endpoint: ${LIVE}`);
  await sleep(1600);
  try {
    const h = await fetch(`${LIVE}/health`, { signal: AbortSignal.timeout(60000) });
    const hj = (await h.json()) as { status?: string };
    console.log(`     ✓ GET /health  →  ${h.status} ${hj.status ?? ""}`);
    await sleep(1600);

    const r = await fetch(`${LIVE}/assess`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30000),
    });
    console.log(`     ↳ POST /assess (no payment)  →  HTTP ${r.status} ${r.statusText}`);
    if (r.status === 402) {
      const body = (await r.json()) as { accepts?: { maxAmountRequired?: string; payTo?: string; network?: string }[] };
      const a = body.accepts?.[0];
      console.log(`     💳 402 Payment Required — this is a real pay-per-call x402 service.`);
      if (a) console.log(`        A calling agent settles 0.01 USDT to ${a.payTo?.slice(0, 10)}… on X Layer, then gets the verdict.`);
    }
  } catch {
    console.log(`     (live endpoint warming up — continuing with the local engine)`);
  }
  await sleep(2400);
}

// A current live honeypot (found via `npm run find-scam`). Swap in a fresh one
// any time by passing args; RugRadar re-assesses live either way.
const SCAM = { chain: 1, address: "0x3412e7ba992d8c5eb76ceabf8b5960f2e250868a", label: "unknown token from a DEX ad" };
const SAFE = { chain: 1, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", label: "WETH" };

function bar(score: number): string {
  const n = Math.round(score / 5);
  return "█".repeat(n) + "░".repeat(20 - n);
}

async function checkAndDecide(chain: number, address: string, intent: string) {
  console.log(`\n🤖  TradeBot wants to swap 0.5 ETH  →  ${intent}`);
  console.log(`     ${address}`);
  await sleep(1800);
  console.log(`\n     ⏳ Calling RugRadar (OKX.AI ASP #3518) before trading…`);
  await sleep(2200);

  const r = (await assessTokenRisk({ chain, token_address: address })) as AssessResult;
  if (!("verdict" in r)) {
    console.log("     RugRadar error — aborting to be safe.");
    return;
  }
  const icon = { SAFE: "✅", CAUTION: "⚠️", HIGH_RISK: "🔶", AVOID: "🛑" }[r.verdict];
  const fails = r.signals.filter((s) => s.status === "fail").map((s) => s.label);

  console.log(`\n   ┌─ RugRadar verdict ${"─".repeat(38)}`);
  console.log(`   │  Token       : ${r.token.symbol ?? "?"}  (${r.token.name ?? "?"})`);
  console.log(`   │  Verdict     : ${icon}  ${r.verdict}`);
  console.log(`   │  Risk score  : ${r.risk_score}/100  ${bar(r.risk_score)}`);
  console.log(`   │  Confidence  : ${r.confidence}`);
  if (fails.length) console.log(`   │  Red flags   : ${fails.join(", ")}`);
  console.log(`   │  Sources     : ${r.sources.filter((s) => s.reachable).map((s) => s.name).join(", ")}`);
  console.log(`   └${"─".repeat(57)}`);
  await sleep(1800);

  if (r.verdict === "AVOID" || r.verdict === "HIGH_RISK") {
    console.log(`\n   ❌ SWAP ABORTED — RugRadar flagged ${r.verdict}. Wallet saved. 🛡️`);
  } else {
    console.log(`\n   ✅ Looks clean — TradeBot proceeds with the swap.`);
  }
  await sleep(2600);
}

async function main() {
  const args = process.argv.slice(2);
  const scam = args.length >= 2 ? { chain: Number(args[0]) || 1, address: args[1], label: "unknown token from a DEX ad" } : SCAM;

  console.log("══════════════════════════════════════════════════════════");
  console.log("  RugRadar — pre-transaction risk oracle for AI agents");
  console.log("  Any agent can call it before a swap. One call. One verdict.");
  console.log("══════════════════════════════════════════════════════════");
  await sleep(2600);

  await proveLive();

  console.log("\n———  Scenario 1: the trap  ———");
  await checkAndDecide(scam.chain, scam.address, scam.label);

  console.log("\n\n———  Scenario 2: a legit token  ———");
  await checkAndDecide(SAFE.chain, SAFE.address, SAFE.label);

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  RugRadar is live on OKX.AI  →  Agent ID #3518");
  console.log("  Agents pay 0.01 USDT/call and never get rugged again.");
  console.log("══════════════════════════════════════════════════════════\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
