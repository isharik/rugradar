/**
 * find-scam — a discovery utility (and demo helper).
 *
 * Live scam tokens rotate constantly, so instead of hardcoding a "known scam"
 * that goes stale, this scans freshly-launched EVM pools (GeckoTerminal) and
 * cross-checks each against honeypot.is (live sell-simulation) + GoPlus, then
 * runs the strongest candidates through RugRadar's own engine. Use it to grab a
 * current AVOID / HIGH_RISK token for the Phase 7 demo:
 *
 *     npm run find-scam
 *
 * It prints the worst offenders it can find right now, already assessed by
 * RugRadar, so you can point your demo at a genuinely live scam.
 */
import "./env.js";
import { assessTokenRisk } from "./assess.js";

const NETS: Record<string, string> = { bsc: "56", eth: "1", base: "8453" };

interface Cand {
  net: string;
  cid: string;
  addr: string;
}

async function newPools(): Promise<Cand[]> {
  const out: Cand[] = [];
  for (const [net, cid] of Object.entries(NETS)) {
    for (const page of [1, 2]) {
      try {
        const r = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/${net}/new_pools?page=${page}`,
          { headers: { accept: "application/json" } },
        );
        const j = (await r.json()) as { data?: { relationships?: { base_token?: { data?: { id?: string } } } }[] };
        for (const p of j.data ?? []) {
          const addr = (p.relationships?.base_token?.data?.id ?? "").split("_")[1];
          if (addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) out.push({ net, cid, addr });
        }
      } catch {
        /* ignore page errors */
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.addr) && seen.add(c.addr));
}

/** Quick honeypot.is triage so we only run the full engine on suspicious ones. */
async function triage(c: Cand): Promise<number> {
  try {
    const r = await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${c.addr}&chainID=${c.cid}`);
    const j = (await r.json()) as {
      honeypotResult?: { isHoneypot?: boolean };
      simulationResult?: { sellTax?: number };
      summary?: { risk?: string };
    };
    let s = 0;
    if (j.honeypotResult?.isHoneypot === true) s += 100;
    const sell = j.simulationResult?.sellTax ?? 0;
    if (sell >= 50) s += 40; else if (sell >= 20) s += 20;
    if (j.summary?.risk === "high") s += 30; else if (j.summary?.risk === "medium") s += 10;
    return s;
  } catch {
    return 0;
  }
}

async function main() {
  console.log("Scanning fresh EVM pools for live scam tokens…\n");
  const cands = await newPools();
  console.log(`Found ${cands.length} newly-launched EVM tokens. Triaging…`);

  const scored: { c: Cand; s: number }[] = [];
  for (const c of cands) scored.push({ c, s: await triage(c) });
  scored.sort((a, b) => b.s - a.s);

  const top = scored.filter((x) => x.s > 0).slice(0, 5);
  if (top.length === 0) {
    console.log("\nNo strongly-suspicious tokens in the current feed. Re-run in a few minutes");
    console.log("(new scams launch constantly) or widen NETS. The engine itself is fine —");
    console.log("this only affects finding a *fresh* demo target.");
    return;
  }

  console.log(`\nRunning RugRadar on the top ${top.length} suspicious tokens:\n`);
  for (const { c } of top) {
    const r = await assessTokenRisk({ chain: c.cid, token_address: c.addr });
    if (!r.ok) {
      console.log(`- ${c.net} ${c.addr}: engine error ${r.error.code}`);
      continue;
    }
    const bad = r.signals.filter((s) => s.status === "fail").map((s) => s.label);
    console.log(
      `• ${r.token.symbol ?? "?"}  [${c.net}]  ${c.addr}\n` +
        `    verdict=${r.verdict}  score=${r.risk_score}  confidence=${r.confidence}\n` +
        `    fails: ${bad.length ? bad.join(", ") : "—"}`,
    );
  }
  console.log("\nPick an AVOID / HIGH_RISK one above for your demo, then:");
  console.log("  npm run assess -- <chain> <address>");
}

main().catch((e) => { console.error(e); process.exit(1); });
