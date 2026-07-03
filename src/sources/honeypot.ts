/**
 * honeypot.is — PRIMARY data source. Free, keyless, confirmed working.
 * Provides real sell-simulation (the strongest anti-honeypot signal), buy/sell
 * tax, token metadata, holder count, open-source/proxy flags, and liquidity.
 *
 * Endpoint: https://api.honeypot.is/v2/IsHoneypot?address=..&chainID=..
 */
import { getJson } from "./http.js";

export interface HoneypotData {
  token?: {
    name?: string;
    symbol?: string;
    decimals?: number;
    address?: string;
    totalHolders?: number;
  };
  summary?: { risk?: string; riskLevel?: number; flags?: unknown[] };
  simulationSuccess?: boolean;
  honeypotResult?: { isHoneypot?: boolean };
  simulationResult?: { buyTax?: number; sellTax?: number; transferTax?: number };
  flags?: string[];
  contractCode?: {
    openSource?: boolean;
    rootOpenSource?: boolean;
    isProxy?: boolean;
    hasProxyCalls?: boolean;
  };
  pair?: { liquidity?: number; pair?: { name?: string; address?: string } };
  // honeypot.is sometimes surfaces errors in-band:
  error?: string;
}

export interface HoneypotOutcome {
  reachable: boolean;
  detail: string;
  data: HoneypotData | null;
}

export async function fetchHoneypot(
  address: string,
  honeypotChainId: number | null,
  timeoutMs: number,
): Promise<HoneypotOutcome> {
  if (honeypotChainId == null) {
    return { reachable: false, detail: "honeypot.is does not support this chain", data: null };
  }
  const url = `https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(
    address,
  )}&chainID=${honeypotChainId}`;
  const res = await getJson<HoneypotData>(url, timeoutMs);
  if (!res.ok || !res.data) {
    return { reachable: false, detail: `unreachable (${res.error ?? "no data"})`, data: null };
  }
  if (res.data.error) {
    // Reached the API but it reported an issue for this token (still useful).
    return { reachable: true, detail: `responded with error: ${res.data.error}`, data: res.data };
  }
  return { reachable: true, detail: "ok", data: res.data };
}
