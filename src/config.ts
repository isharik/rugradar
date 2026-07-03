/**
 * RugRadar configuration.
 *
 * Two independent layers, deliberately decoupled:
 *
 *  1. RISK-DATA layer  — always reads from PUBLIC MAINNET data sources so that
 *     real scam tokens exist for assessment. Free + keyless in v1.
 *
 *  2. PAYMENT layer    — swappable testnet<->mainnet via PAYMENT_MODE. Used only
 *     once the OKX Payment SDK is integrated (Phase 5). Building on testnet keeps
 *     the project at ~$0; flip to mainnet to go live. Nothing in the risk engine
 *     depends on this — you can develop and test the full oracle with the payment
 *     layer untouched.
 *
 * Adding a new chain = add one entry to CHAINS. Everything else is generic.
 */

export interface ChainConfig {
  /** EVM chain id. */
  id: number;
  /** Human name. */
  name: string;
  /** Short aliases accepted as chain input (case-insensitive). */
  aliases: string[];
  /** Ordered list of free public RPC endpoints; tried in order (failover). */
  rpcUrls: string[];
  /** chainID param used by honeypot.is (matches EVM id for supported chains). */
  honeypotChainId: number | null;
  /** chain id path segment used by the GoPlus token_security endpoint. */
  goplusChainId: string | null;
  /** Block explorer base (for human-facing links in explanations). */
  explorer: string;
  /** Native symbol (informational). */
  nativeSymbol: string;
}

/**
 * v1 ships Ethereum as the primary chain (richest scam-token examples + best
 * free tooling). BSC and Base are pre-wired to prove "adding chains is easy" —
 * both are supported by honeypot.is and GoPlus with no code changes.
 */
export const CHAINS: Record<number, ChainConfig> = {
  1: {
    id: 1,
    name: "Ethereum",
    aliases: ["eth", "ethereum", "mainnet", "ethereum-mainnet"],
    rpcUrls: splitEnv("RPC_URLS_1", [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://rpc.mevblocker.io",
    ]),
    honeypotChainId: 1,
    goplusChainId: "1",
    explorer: "https://etherscan.io",
    nativeSymbol: "ETH",
  },
  56: {
    id: 56,
    name: "BNB Smart Chain",
    aliases: ["bsc", "bnb", "binance", "bnb-chain"],
    rpcUrls: splitEnv("RPC_URLS_56", [
      "https://bsc-rpc.publicnode.com",
      "https://bsc-dataseed.binance.org",
    ]),
    honeypotChainId: 56,
    goplusChainId: "56",
    explorer: "https://bscscan.com",
    nativeSymbol: "BNB",
  },
  8453: {
    id: 8453,
    name: "Base",
    aliases: ["base", "base-mainnet"],
    rpcUrls: splitEnv("RPC_URLS_8453", [
      "https://base-rpc.publicnode.com",
      "https://mainnet.base.org",
    ]),
    honeypotChainId: 8453,
    goplusChainId: "8453",
    explorer: "https://basescan.org",
    nativeSymbol: "ETH",
  },
};

export interface AppConfig {
  defaultChainId: number;
  goplusEnabled: boolean;
  sourceTimeoutMs: number;
  httpPort: number;
  payment: {
    mode: "testnet" | "mainnet";
    pricePerCall: number;
    /** Master switch: when true, the paid A2MCP route enforces x402. */
    enabled: boolean;
    /** x402 network id (CAIP-2). X Layer mainnet = eip155:196. */
    network: string;
    /** Payment asset (must be USDT or USDG for OKX A2MCP). */
    assetAddress: string;
    assetSymbol: string;
    assetDecimals: number;
    /** Where callers pay — your Agentic Wallet address. */
    payTo: string;
    /** Optional x402 facilitator address (for schemes that require it). */
    facilitatorAddress: string;
    /** Public base URL of the deployed endpoint (used as the x402 `resource`). */
    publicUrl: string;
    okxApiKey: string;
    okxSecretKey: string;
    okxPassphrase: string;
  };
}

// X Layer (196) stablecoins, verified on-chain. USDT/USDG are the tokens OKX
// A2MCP accepts; USDC is present on-chain but not accepted for A2MCP fees.
const XLAYER_ASSETS = {
  USDT: { address: "0x779ded0c9e1022225f8e0630b35a9b54be713736", decimals: 6 },
  USDG: { address: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", decimals: 6 },
};

export const CONFIG: AppConfig = {
  defaultChainId: intEnv("DEFAULT_CHAIN_ID", 1),
  goplusEnabled: boolEnv("GOPLUS_ENABLED", true),
  sourceTimeoutMs: intEnv("SOURCE_TIMEOUT_MS", 6000),
  httpPort: intEnv("HTTP_PORT", 8787),
  payment: (() => {
    const symbol = (process.env.PAY_ASSET_SYMBOL ?? "USDT").toUpperCase();
    const asset = symbol === "USDG" ? XLAYER_ASSETS.USDG : XLAYER_ASSETS.USDT;
    return {
      mode: (process.env.PAYMENT_MODE === "mainnet" ? "mainnet" : "testnet") as "testnet" | "mainnet",
      pricePerCall: floatEnv("PRICE_PER_CALL", 0.01),
      enabled: boolEnv("PAYMENTS_ENABLED", false),
      network: process.env.PAY_NETWORK ?? "eip155:196",
      assetAddress: process.env.PAY_ASSET_ADDRESS ?? asset.address,
      assetSymbol: symbol,
      assetDecimals: asset.decimals,
      payTo: (process.env.PAY_TO ?? "").toLowerCase(),
      facilitatorAddress: process.env.PAY_FACILITATOR ?? "",
      // On Render, RENDER_EXTERNAL_URL is injected automatically → no manual step.
      publicUrl: process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "",
      okxApiKey: process.env.OKX_API_KEY ?? "",
      okxSecretKey: process.env.OKX_SECRET_KEY ?? "",
      okxPassphrase: process.env.OKX_PASSPHRASE ?? "",
    };
  })(),
};

/** Resolve a caller-supplied chain (id or name/alias) to a ChainConfig. */
export function resolveChain(input: string | number): ChainConfig | null {
  if (typeof input === "number" || /^\d+$/.test(String(input).trim())) {
    const id = Number(input);
    return CHAINS[id] ?? null;
  }
  const needle = String(input).trim().toLowerCase();
  for (const chain of Object.values(CHAINS)) {
    if (chain.name.toLowerCase() === needle || chain.aliases.includes(needle)) {
      return chain;
    }
  }
  return null;
}

export function supportedChainsSummary(): { id: number; name: string; aliases: string[] }[] {
  return Object.values(CHAINS).map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));
}

// --- tiny env helpers (no dependency on dotenv; that's loaded by entrypoints) ---
function splitEnv(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (!raw || !raw.trim()) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function intEnv(key: string, fallback: number): number {
  const n = parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}
function floatEnv(key: string, fallback: number): number {
  const n = parseFloat(process.env[key] ?? "");
  return Number.isFinite(n) ? n : fallback;
}
function boolEnv(key: string, fallback: boolean): boolean {
  const v = (process.env[key] ?? "").trim().toLowerCase();
  if (v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}
