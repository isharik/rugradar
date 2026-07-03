/**
 * Core risk engine — a pure, stateless, idempotent function. Given a chain +
 * token address it fans out to the (free) data sources in parallel, builds an
 * explicit list of signal checks, computes a 0..100 risk score + verdict, a
 * confidence level, and a human-relayable explanation.
 *
 * Principles enforced here:
 *  - Never fake a result: a signal we cannot source is reported "not_available"
 *    and contributes 0 to the score (not a false "pass").
 *  - Never fail the whole call because one source is down: everything is
 *    best-effort; missing sources lower confidence and are noted.
 *  - Honeypot / cannot-sell is dominant: if a token cannot be sold, it is AVOID
 *    regardless of anything else.
 */
import {
  AssessInputSchema,
  type AssessOutput,
  type AssessResult,
  type Confidence,
  type SignalCheck,
  type SourceStatus,
  type Verdict,
} from "./schema.js";
import { CONFIG, resolveChain, supportedChainsSummary } from "./config.js";
import { fetchHoneypot } from "./sources/honeypot.js";
import { fetchRpc } from "./sources/rpc.js";
import { fetchGoPlus } from "./sources/goplus.js";

/** GoPlus encodes booleans as "1"/"0" strings; normalize to tri-state. */
function gpBool(v: string | undefined): boolean | null {
  if (v === "1") return true;
  if (v === "0") return false;
  return null;
}

export async function assessTokenRisk(rawInput: unknown): Promise<AssessOutput> {
  // 1) Validate input.
  const parsed = AssessInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
        details: { expected: { token_address: "0x… (40 hex)", chain: "id or name (optional)" } },
      },
    };
  }
  const input = parsed.data;
  const address = input.token_address.toLowerCase();

  // 2) Resolve chain (default to configured chain when omitted).
  const chain = resolveChain(input.chain ?? CONFIG.defaultChainId);
  if (!chain) {
    return {
      ok: false,
      error: {
        code: "UNSUPPORTED_CHAIN",
        message: `Chain '${input.chain}' is not supported yet.`,
        details: { supported: supportedChainsSummary() },
      },
    };
  }

  // 3) Fan out to all sources in parallel (best-effort; none can throw).
  const timeout = CONFIG.sourceTimeoutMs;
  const [honeypot, rpc, goplus] = await Promise.all([
    fetchHoneypot(address, chain.honeypotChainId, timeout),
    fetchRpc(address, chain.rpcUrls, timeout),
    CONFIG.goplusEnabled
      ? fetchGoPlus(address, chain.goplusChainId, timeout)
      : Promise.resolve({ reachable: false, detail: "disabled via config", data: null }),
  ]);

  const sources: SourceStatus[] = [
    { name: "honeypot.is", reachable: honeypot.reachable, detail: honeypot.detail },
    { name: "public-rpc", reachable: rpc.reachable, detail: rpc.detail },
    { name: "goplus", reachable: goplus.reachable, detail: goplus.detail },
  ];
  const notes: string[] = [];
  for (const s of sources) if (!s.reachable) notes.push(`Source '${s.name}' unavailable: ${s.detail}.`);

  const hp = honeypot.data;
  const gp = goplus.data;
  const rp = rpc.data;

  // 4) Build signals + accumulate score.
  const signals: SignalCheck[] = [];
  let score = 0;
  const add = (s: SignalCheck) => {
    signals.push(s);
    score += s.weight;
  };

  // Track whether we ever proved sellability failure (dominant → AVOID).
  let cannotSell = false;

  // --- Signal: sellability / honeypot (PRIMARY: honeypot.is sim, backup: GoPlus) ---
  {
    const isHp = hp?.honeypotResult?.isHoneypot;
    const simOk = hp?.simulationSuccess;
    const gpHp = gpBool(gp?.is_honeypot);
    const gpCannotSell = gpBool(gp?.cannot_sell_all);
    if (isHp === true || gpHp === true || gpCannotSell === true) {
      cannotSell = true;
      add({ id: "sellability", label: "Sellability / honeypot", status: "fail",
        detail: "Simulated sell FAILED — token appears to be a honeypot (cannot sell).", value: true, weight: 80 });
    } else if (isHp === false || simOk === true || gpHp === false) {
      add({ id: "sellability", label: "Sellability / honeypot", status: "pass",
        detail: "Simulated buy+sell succeeded — token is sellable.", value: false, weight: 0 });
    } else if (simOk === false) {
      add({ id: "sellability", label: "Sellability / honeypot", status: "warn",
        detail: "Sell simulation could not complete — treat with caution.", value: null, weight: 25 });
    } else {
      add({ id: "sellability", label: "Sellability / honeypot", status: "not_available",
        detail: "No source could simulate a sell.", value: null, weight: 0 });
    }
  }

  // --- Signal: aggregated third-party risk rating (honeypot.is summary) ---
  {
    const risk = hp?.summary?.risk?.toLowerCase();
    const level = hp?.summary?.riskLevel;
    if (risk == null) {
      add({ id: "risk_rating", label: "Third-party risk rating", status: "not_available", detail: "No aggregated rating available.", value: null, weight: 0 });
    } else if (risk === "high") {
      add({ id: "risk_rating", label: "Third-party risk rating", status: "fail", detail: `honeypot.is rates this HIGH risk (level ${level ?? "?"}).`, value: risk, weight: 20 });
    } else if (risk === "medium") {
      add({ id: "risk_rating", label: "Third-party risk rating", status: "warn", detail: `honeypot.is rates this MEDIUM risk (level ${level ?? "?"}).`, value: risk, weight: 8 });
    } else {
      add({ id: "risk_rating", label: "Third-party risk rating", status: "pass", detail: `honeypot.is rates this low risk.`, value: risk, weight: 0 });
    }
  }

  // --- Signal: buy/sell tax ---
  {
    const sell = hp?.simulationResult?.sellTax ?? (gp?.sell_tax != null ? Number(gp.sell_tax) * 100 : undefined);
    const buy = hp?.simulationResult?.buyTax ?? (gp?.buy_tax != null ? Number(gp.buy_tax) * 100 : undefined);
    if (sell == null && buy == null) {
      add({ id: "taxes", label: "Buy/sell tax", status: "not_available", detail: "No tax data from any source.", value: null, weight: 0 });
    } else {
      const s = sell ?? 0;
      const b = buy ?? 0;
      let w = 0;
      if (s >= 50) w += 40; else if (s >= 20) w += 25; else if (s >= 10) w += 10;
      if (b >= 20) w += 15; else if (b >= 10) w += 8;
      const status = w >= 25 ? "fail" : w > 0 ? "warn" : "pass";
      add({ id: "taxes", label: "Buy/sell tax", status,
        detail: `Buy tax ${b.toFixed(1)}%, sell tax ${s.toFixed(1)}%.`, value: `buy ${b.toFixed(1)}% / sell ${s.toFixed(1)}%`, weight: w });
    }
  }

  // --- Signal: mint authority (GoPlus only) ---
  {
    const mintable = gpBool(gp?.is_mintable);
    if (mintable == null) {
      add({ id: "mint_authority", label: "Mint authority", status: "not_available", detail: goplus.reachable ? "Mintability not reported for this token." : "Mintability not sourceable (GoPlus unavailable).", value: null, weight: 0 });
    } else if (mintable) {
      add({ id: "mint_authority", label: "Mint authority", status: "warn", detail: "Token is mintable — supply can be inflated by the owner.", value: true, weight: 15 });
    } else {
      add({ id: "mint_authority", label: "Mint authority", status: "pass", detail: "Not mintable — fixed supply.", value: false, weight: 0 });
    }
  }

  // --- Signal: liquidity presence ---
  {
    const hpLiq = hp?.pair?.liquidity;
    const gpHasDex = Array.isArray(gp?.dex) && (gp?.dex?.length ?? 0) > 0;
    if (hpLiq == null && gp?.dex == null) {
      add({ id: "liquidity_present", label: "Liquidity present", status: "not_available", detail: "Liquidity data not sourceable.", value: null, weight: 0 });
    } else if ((hpLiq != null && hpLiq > 0) || gpHasDex) {
      const amt = hpLiq != null ? `$${Math.round(hpLiq).toLocaleString()}` : "present";
      add({ id: "liquidity_present", label: "Liquidity present", status: "pass", detail: `DEX liquidity ${amt}.`, value: hpLiq ?? true, weight: 0 });
    } else {
      add({ id: "liquidity_present", label: "Liquidity present", status: "fail", detail: "No DEX liquidity found — likely untradeable / abandoned.", value: 0, weight: 25 });
    }
  }

  // --- Signal: liquidity lock (GoPlus lp_holders) ---
  {
    const lp = gp?.lp_holders;
    if (!Array.isArray(lp) || lp.length === 0) {
      add({ id: "liquidity_locked", label: "Liquidity lock", status: "not_available", detail: "LP lock status not sourceable.", value: null, weight: 0 });
    } else {
      const lockedPct = lp.filter((h) => h.is_locked === 1).reduce((a, h) => a + (Number(h.percent) || 0), 0) * 100;
      if (lockedPct >= 50) {
        add({ id: "liquidity_locked", label: "Liquidity lock", status: "pass", detail: `${lockedPct.toFixed(0)}% of LP is locked/burned.`, value: lockedPct, weight: 0 });
      } else if (lockedPct > 0) {
        add({ id: "liquidity_locked", label: "Liquidity lock", status: "warn", detail: `Only ${lockedPct.toFixed(0)}% of LP is locked — rug risk if owner pulls the rest.`, value: lockedPct, weight: 10 });
      } else {
        add({ id: "liquidity_locked", label: "Liquidity lock", status: "fail", detail: "LP is not locked — owner can pull liquidity at any time.", value: 0, weight: 15 });
      }
    }
  }

  // --- Signal: ownership renouncement (GoPlus owner_address, backup: RPC owner()) ---
  {
    const gpOwner = gp?.owner_address?.toLowerCase();
    const canTakeBack = gpBool(gp?.can_take_back_ownership);
    const zero = "0x0000000000000000000000000000000000000000";
    const renouncedGp = gpOwner != null ? gpOwner === zero || gpOwner === "" : null;
    const renouncedRpc = rp?.ownerRenounced;
    const renounced = renouncedGp ?? renouncedRpc;
    if (canTakeBack === true) {
      add({ id: "ownership_renounced", label: "Ownership renounced", status: "fail", detail: "Ownership can be re-claimed ('take back ownership') — privileges not truly renounced.", value: false, weight: 15 });
    } else if (renounced === true) {
      add({ id: "ownership_renounced", label: "Ownership renounced", status: "pass", detail: "Ownership renounced (owner = zero address).", value: true, weight: 0 });
    } else if (renounced === false) {
      add({ id: "ownership_renounced", label: "Ownership renounced", status: "warn", detail: "Owner retains privileged control over the contract.", value: false, weight: 10 });
    } else if (canTakeBack === false) {
      // GoPlus checked and found no owner takeback and surfaced no owner address:
      // effectively no privileged owner (e.g. ownerless tokens like WETH).
      add({ id: "ownership_renounced", label: "Ownership renounced", status: "pass", detail: "No privileged owner / take-back capability detected.", value: true, weight: 0 });
    } else {
      add({ id: "ownership_renounced", label: "Ownership renounced", status: "not_available", detail: "Owner not sourceable from RPC or GoPlus.", value: null, weight: 0 });
    }
  }

  // --- Signal: top-10 holder concentration (GoPlus holders) ---
  {
    const holders = gp?.holders;
    if (!Array.isArray(holders) || holders.length === 0) {
      add({ id: "holder_concentration", label: "Top-10 holder concentration", status: "not_available", detail: "Holder distribution not sourceable.", value: null, weight: 0 });
    } else {
      // Dump risk comes from EOA holders who can freely sell. Exclude burn
      // addresses, locked LP, and contracts (DEX pools / bridges / lockers),
      // which are not "whales" in the sell-pressure sense. We report the total
      // for context but score on the EOA concentration.
      const eligible = holders.slice(0, 10).filter(
        (h) => !(h.tag ?? "").toLowerCase().includes("burn") && h.is_locked !== 1,
      );
      const total10 = eligible.reduce((a, h) => a + (Number(h.percent) || 0), 0) * 100;
      const eoa10 = eligible
        .filter((h) => h.is_contract !== 1)
        .reduce((a, h) => a + (Number(h.percent) || 0), 0) * 100;
      const detail = `Top-10 EOA holders control ${eoa10.toFixed(0)}% (total top-10 incl. contracts ${total10.toFixed(0)}%).`;
      if (eoa10 >= 70) {
        add({ id: "holder_concentration", label: "Top-10 holder concentration", status: "fail", detail: `${detail} Extreme concentration / dump risk.`, value: eoa10, weight: 20 });
      } else if (eoa10 >= 50) {
        add({ id: "holder_concentration", label: "Top-10 holder concentration", status: "warn", detail: `${detail} Elevated concentration.`, value: eoa10, weight: 10 });
      } else {
        add({ id: "holder_concentration", label: "Top-10 holder concentration", status: "pass", detail: `${detail} Reasonably distributed among individuals.`, value: eoa10, weight: 0 });
      }
    }
  }

  // --- Signal: known malicious / drain patterns (GoPlus flags + honeypot.is flags) ---
  {
    const badFlags: string[] = [];
    const map: Record<string, string> = {
      is_blacklisted: "blacklist function",
      transfer_pausable: "transfers can be paused",
      trading_cooldown: "trading cooldown",
      hidden_owner: "hidden owner",
      selfdestruct: "self-destruct",
      external_call: "external call in transfer",
      owner_change_balance: "owner can change balances",
      slippage_modifiable: "modifiable tax/slippage",
      personal_slippage_modifiable: "per-address slippage",
      cannot_buy: "cannot buy",
    };
    for (const [k, label] of Object.entries(map)) {
      if (gpBool((gp as Record<string, string | undefined> | null)?.[k]) === true) badFlags.push(label);
    }
    // honeypot.is textual flags (e.g. "high_taxes", "low_liquidity") add colour.
    const hpFlags = Array.isArray(hp?.flags) ? hp!.flags! : [];
    for (const f of hpFlags) if (typeof f === "string") badFlags.push(f.replace(/_/g, " "));

    if (gp == null && hpFlags.length === 0) {
      add({ id: "malicious_patterns", label: "Malicious / drain patterns", status: "not_available", detail: goplus.reachable ? "No pattern flags reported for this token." : "Pattern flags not sourceable (GoPlus unavailable).", value: null, weight: 0 });
    } else if (badFlags.length === 0) {
      add({ id: "malicious_patterns", label: "Malicious / drain patterns", status: "pass", detail: "No known malicious/approval-drain patterns detected.", value: 0, weight: 0 });
    } else {
      const w = Math.min(45, badFlags.length * 15);
      add({ id: "malicious_patterns", label: "Malicious / drain patterns", status: badFlags.length >= 2 ? "fail" : "warn", detail: `Detected: ${badFlags.join(", ")}.`, value: badFlags.join(", "), weight: w });
    }
  }

  // --- Signal: verified / open source ---
  {
    const open = hp?.contractCode?.openSource ?? gpBool(gp?.is_open_source) ?? null;
    if (open == null) {
      add({ id: "open_source", label: "Verified source code", status: "not_available", detail: "Verification status unknown.", value: null, weight: 0 });
    } else if (open) {
      add({ id: "open_source", label: "Verified source code", status: "pass", detail: "Contract source is verified/open.", value: true, weight: 0 });
    } else {
      add({ id: "open_source", label: "Verified source code", status: "warn", detail: "Contract source is NOT verified — behaviour is opaque.", value: false, weight: 20 });
    }
  }

  // --- Signal: proxy / upgradeable ---
  {
    // Prefer GoPlus proxy detection (real bytecode analysis); honeypot.is over-
    // reports isProxy for some standard contracts (e.g. WETH), so it's a fallback.
    const proxy = gpBool(gp?.is_proxy) ?? hp?.contractCode?.isProxy ?? null;
    if (proxy == null) {
      add({ id: "proxy", label: "Upgradeable proxy", status: "not_available", detail: "Proxy status unknown.", value: null, weight: 0 });
    } else if (proxy) {
      add({ id: "proxy", label: "Upgradeable proxy", status: "warn", detail: "Upgradeable proxy — contract logic can change after deployment.", value: true, weight: 10 });
    } else {
      add({ id: "proxy", label: "Upgradeable proxy", status: "pass", detail: "Not an upgradeable proxy.", value: false, weight: 0 });
    }
  }

  // 5) Finalize score + verdict.
  if (cannotSell) score = Math.max(score, 90); // dominant floor
  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: Verdict;
  if (cannotSell || score >= 70) verdict = "AVOID";
  else if (score >= 40) verdict = "HIGH_RISK";
  else if (score >= 15) verdict = "CAUTION";
  else verdict = "SAFE";

  // 6) Confidence: driven by source coverage + whether a sell was simulated.
  const reachableCount = sources.filter((s) => s.reachable).length;
  const naCount = signals.filter((s) => s.status === "not_available").length;
  let confidence: Confidence;
  if (!honeypot.reachable && !goplus.reachable) confidence = "low";
  else if (reachableCount >= 2 && (hp?.simulationSuccess === true || gp != null) && naCount <= 3) confidence = "high";
  else confidence = "medium";

  // 7) Token metadata (prefer honeypot.is, fall back to RPC).
  const token = {
    name: hp?.token?.name ?? rp?.name ?? gp?.token_name ?? null,
    symbol: hp?.token?.symbol ?? rp?.symbol ?? gp?.token_symbol ?? null,
    decimals: hp?.token?.decimals ?? rp?.decimals ?? null,
    total_holders: hp?.token?.totalHolders ?? (gp?.holder_count != null ? Number(gp.holder_count) : null),
  };

  // 8) Human-relayable explanation.
  const explanation = buildExplanation(token, verdict, score, confidence, signals, sources);

  const result: AssessResult = {
    ok: true,
    request: { chain_id: chain.id, chain_name: chain.name, token_address: address },
    token,
    risk_score: score,
    verdict,
    confidence,
    signals,
    explanation,
    sources,
    notes,
    assessed_at: new Date().toISOString(),
    explorer_url: `${chain.explorer}/token/${address}`,
  };
  return result;
}

function buildExplanation(
  token: AssessResult["token"],
  verdict: Verdict,
  score: number,
  confidence: Confidence,
  signals: SignalCheck[],
  sources: SourceStatus[],
): string {
  const name = token.symbol || token.name || "This token";
  const fails = signals.filter((s) => s.status === "fail").map((s) => s.label.toLowerCase());
  const warns = signals.filter((s) => s.status === "warn").map((s) => s.label.toLowerCase());
  const reachable = sources.filter((s) => s.reachable).map((s) => s.name);

  const lead: Record<Verdict, string> = {
    AVOID: `${name} is flagged AVOID (risk ${score}/100). Do not swap into or approve this token.`,
    HIGH_RISK: `${name} is HIGH RISK (risk ${score}/100). Proceed only if you fully understand the danger.`,
    CAUTION: `${name} warrants CAUTION (risk ${score}/100). It is likely tradeable but has issues worth noting.`,
    SAFE: `${name} looks relatively SAFE (risk ${score}/100) on the checks we could run.`,
  };
  let msg = lead[verdict];
  if (fails.length) msg += ` Critical problems: ${fails.join(", ")}.`;
  if (warns.length) msg += ` Cautions: ${warns.join(", ")}.`;
  if (!fails.length && !warns.length && verdict === "SAFE") {
    msg += ` No red flags surfaced across sellability, taxes, liquidity, ownership, or malicious patterns.`;
  }
  msg += ` Confidence is ${confidence}, based on ${reachable.length} of ${sources.length} data sources reachable (${reachable.join(", ") || "none"}).`;
  if (confidence !== "high") {
    msg += ` Some checks were unavailable, so treat this as a partial assessment and re-run if a source recovers.`;
  }
  msg += ` This is automated risk information, not financial advice.`;
  return msg;
}
