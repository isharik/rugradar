/**
 * CLI test harness. Two modes:
 *   npm run assess -- <chain> <address>      # assess one token, print JSON
 *   npm run test:discriminate                # prove SAFE vs SCAM discrimination
 */
import "./env.js";
import { assessTokenRisk } from "./assess.js";

// Well-known reference tokens for the discrimination self-test.
const KNOWN_GOOD = [
  { label: "USDC (Ethereum)", chain: 1, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { label: "WETH (Ethereum)", chain: 1, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
];
// SQUID — the infamous "Squid Game" honeypot/rug on BNB Chain.
const KNOWN_SCAM = [
  { label: "SQUID honeypot (BNB Chain)", chain: 56, address: "0x87230146E138d3F296a9a77e497A2A83012e9Bc5" },
];

function short(o: Awaited<ReturnType<typeof assessTokenRisk>>): string {
  if (!o.ok) return `ERROR ${o.error.code}: ${o.error.message}`;
  const flags = o.signals.filter((s) => s.status === "fail" || s.status === "warn").map((s) => `${s.label}=${s.status}`);
  return [
    `${o.token.symbol ?? "?"}  verdict=${o.verdict}  score=${o.risk_score}  confidence=${o.confidence}`,
    `  sources: ${o.sources.map((s) => `${s.name}:${s.reachable ? "ok" : "down"}`).join("  ")}`,
    `  flags: ${flags.length ? flags.join(", ") : "none"}`,
  ].join("\n");
}

async function selftest() {
  console.log("=== RugRadar discrimination self-test ===\n");
  console.log("--- KNOWN-GOOD tokens (expect SAFE/CAUTION) ---");
  for (const t of KNOWN_GOOD) {
    const r = await assessTokenRisk({ chain: t.chain, token_address: t.address });
    console.log(`\n${t.label}\n${short(r)}`);
  }
  console.log("\n--- KNOWN-SCAM tokens (expect HIGH_RISK/AVOID) ---");
  for (const t of KNOWN_SCAM) {
    const r = await assessTokenRisk({ chain: t.chain, token_address: t.address });
    console.log(`\n${t.label}\n${short(r)}`);
  }
  console.log("\n=== end self-test ===");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest") || args.includes("--self-test")) {
    await selftest();
    return;
  }
  if (args.length < 1) {
    console.error("Usage: npm run assess -- <chain> <address>   |   npm run test:discriminate");
    process.exit(1);
  }
  // Accept "<chain> <address>" or just "<address>" (defaults chain).
  let chain: string | number | undefined;
  let address: string;
  if (args.length >= 2) { chain = args[0]; address = args[1]; }
  else { address = args[0]; }
  const result = await assessTokenRisk({ chain, token_address: address });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
