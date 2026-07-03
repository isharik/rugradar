/**
 * x402 seller layer for RugRadar's paid A2MCP endpoint.
 *
 * OKX's A2MCP model is a single request → 402 challenge → pay → replay. This
 * module builds the standards-compliant 402 challenge (x402) that OKX's
 * `onchainos agent x402-check` validates and that a paying agent's
 * okx-agent-payments-protocol consumes.
 *
 * It advertises: the price (in USDT/USDG on X Layer), the payTo address (your
 * Agentic Wallet), and the input schema the paid replay must carry
 * (token_address + optional chain). Settlement of the signed authorization is
 * performed by OKX's payment infrastructure (task-402-pay), so this layer's job
 * is to (a) issue a correct challenge and (b) recognise a paid replay.
 */
import type { IncomingMessage } from "node:http";
import { CONFIG } from "./config.js";

/** Atomic amount string for the configured price + asset decimals. */
function atomicAmount(): string {
  const { pricePerCall, assetDecimals } = CONFIG.payment;
  // Avoid float drift: scale via string math on 6-dp tokens.
  const scaled = Math.round(pricePerCall * 10 ** assetDecimals);
  return String(scaled);
}

/** The x402 `accepts` entry describing how to pay for one assessment. */
export function buildAccepts(resourceUrl: string) {
  const p = CONFIG.payment;
  const entry: Record<string, unknown> = {
    scheme: "exact",
    network: p.network,
    maxAmountRequired: atomicAmount(),
    resource: resourceUrl,
    description: "RugRadar assess_token_risk — pre-transaction token risk verdict",
    mimeType: "application/json",
    payTo: p.payTo,
    maxTimeoutSeconds: 120,
    asset: p.assetAddress,
    // Input the paid replay must carry — lets x402-check surface required fields.
    outputSchema: {
      input: {
        type: "http",
        method: "POST",
        bodyType: "json",
        body: {
          type: "object",
          properties: {
            token_address: {
              type: "string",
              description: "0x-prefixed token/contract address to assess (40 hex chars).",
            },
            chain: {
              type: ["string", "number"],
              description: "Chain id (e.g. 1) or name ('ethereum','bsc','base'). Defaults to Ethereum.",
            },
          },
          required: ["token_address"],
        },
      },
    },
    extra: {
      name: p.assetSymbol,
      symbol: p.assetSymbol,
      version: "2",
      decimals: p.assetDecimals,
      ...(p.facilitatorAddress ? { facilitatorAddress: p.facilitatorAddress } : {}),
    },
  };
  return entry;
}

/** Full x402 challenge object (v1 body shape; also base64-encoded for the v2 header). */
export function buildChallenge(resourceUrl: string) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required to call this paid resource",
    accepts: [buildAccepts(resourceUrl)],
  };
}

/** base64 of the challenge, for the `PAYMENT-REQUIRED` (x402 v2) response header. */
export function challengeHeader(resourceUrl: string): string {
  return Buffer.from(JSON.stringify(buildChallenge(resourceUrl)), "utf8").toString("base64");
}

/**
 * Detect a paid replay. A paying agent attaches its authorization via one of
 * the standard x402 headers. We treat presence as "paid" at the HTTP layer;
 * OKX's infrastructure verifies + settles the signed authorization.
 */
export function getPaymentHeader(req: IncomingMessage): string | null {
  const h = req.headers;
  const v =
    (h["x-payment"] as string | undefined) ??
    (h["payment-signature"] as string | undefined) ??
    (h["x-payment-signature"] as string | undefined);
  return v && v.trim() ? v.trim() : null;
}

/** Whether the paid route should enforce payment right now. */
export function paymentsActive(): boolean {
  return CONFIG.payment.enabled && !!CONFIG.payment.payTo;
}
