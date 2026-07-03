/**
 * GoPlus Security — OPTIONAL enrichment source. Free, keyless for the basic
 * token_security endpoint. Adds signals no other free source gives us cleanly:
 *   - mint authority (is_mintable)
 *   - LP lock status (lp_holders[].is_locked, locked %)
 *   - top-10 holder concentration (holders[].percent)
 *   - malicious patterns (blacklist, transfer_pausable, hidden_owner, ...)
 *
 * IMPORTANT: GoPlus may be geo/edge-blocked from some networks. When it is
 * unreachable, RugRadar MUST NOT fail — it degrades gracefully: the signals
 * this source would have filled become "not_available", confidence drops, and
 * a note records the missing source. That behaviour is the whole point of the
 * reliability requirement, so this module only ever returns, never throws.
 *
 * Endpoint: https://api.gopluslabs.io/api/v1/token_security/{chainId}?contract_addresses=..
 */
import { getJson } from "./http.js";

export interface GoPlusHolder {
  address?: string;
  tag?: string;
  is_contract?: number;
  balance?: string;
  percent?: string; // e.g. "0.123" == 12.3%
  is_locked?: number;
}

export interface GoPlusTokenSecurity {
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  owner_address?: string;
  can_take_back_ownership?: string;
  owner_change_balance?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  external_call?: string;
  is_honeypot?: string;
  cannot_sell_all?: string;
  cannot_buy?: string;
  transfer_pausable?: string;
  trading_cooldown?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  is_anti_whale?: string;
  slippage_modifiable?: string;
  personal_slippage_modifiable?: string;
  buy_tax?: string;
  sell_tax?: string;
  holder_count?: string;
  total_supply?: string;
  holders?: GoPlusHolder[];
  lp_holders?: GoPlusHolder[];
  lp_total_supply?: string;
  dex?: { name?: string; liquidity?: string }[];
  token_name?: string;
  token_symbol?: string;
}

export interface GoPlusOutcome {
  reachable: boolean;
  detail: string;
  data: GoPlusTokenSecurity | null;
}

export async function fetchGoPlus(
  address: string,
  goplusChainId: string | null,
  timeoutMs: number,
): Promise<GoPlusOutcome> {
  if (goplusChainId == null) {
    return { reachable: false, detail: "GoPlus does not support this chain", data: null };
  }
  const url = `https://api.gopluslabs.io/api/v1/token_security/${goplusChainId}?contract_addresses=${encodeURIComponent(
    address.toLowerCase(),
  )}`;
  const res = await getJson<{ code?: number; message?: string; result?: Record<string, GoPlusTokenSecurity> }>(
    url,
    timeoutMs,
  );
  if (!res.ok || !res.data) {
    return { reachable: false, detail: `unreachable (${res.error ?? "no data"})`, data: null };
  }
  const result = res.data.result ?? {};
  const key = Object.keys(result).find((k) => k.toLowerCase() === address.toLowerCase());
  const token = key ? result[key] : undefined;
  if (!token || Object.keys(token).length === 0) {
    return { reachable: true, detail: "responded but no data for this token", data: null };
  }
  return { reachable: true, detail: "ok", data: token };
}
