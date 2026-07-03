/**
 * RugRadar MCP server (stdio transport).
 *
 * Exposes ONE tool — assess_token_risk — the A2MCP entrypoint other agents call
 * before a swap/approval. This is what OpenClaw loads locally and what gets
 * registered/listed on the OKX.AI marketplace.
 *
 * The payment layer (OKX Payment SDK, pay-per-call) is intentionally NOT wired
 * here yet — it is added in Phase 5 as a thin wrapper around this same tool,
 * config-driven via PAYMENT_MODE so testnet<->mainnet is a one-line switch.
 */
import "./env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRugRadarServer } from "./server.js";
import { CONFIG } from "./config.js";

async function main() {
  const server = createRugRadarServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP channel).
  console.error(
    `RugRadar MCP ready (stdio). payment_mode=${CONFIG.payment.mode} price_per_call=${CONFIG.payment.pricePerCall} ` +
      `default_chain=${CONFIG.defaultChainId}`,
  );
}

main().catch((e) => {
  console.error("RugRadar MCP failed to start:", e);
  process.exit(1);
});
