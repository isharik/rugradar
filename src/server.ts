/**
 * Shared MCP server factory. Both transports — stdio (local agents like Claude
 * Code / OpenClaw) and Streamable HTTP (the public A2MCP endpoint listed on the
 * OKX.AI marketplace) — build the server from here so there is ONE definition of
 * the assess_token_risk tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assessTokenRisk } from "./assess.js";
import { supportedChainsSummary } from "./config.js";

export function createRugRadarServer(): McpServer {
  const server = new McpServer({ name: "rugradar", version: "0.1.0" });

  server.registerTool(
    "assess_token_risk",
    {
      title: "Assess token risk (RugRadar)",
      description:
        "Pre-transaction risk oracle. Given a chain + token/contract address, returns a structured risk verdict " +
        "(SAFE / CAUTION / HIGH_RISK / AVOID) with a 0-100 score, individual signal checks (sellability/honeypot, " +
        "buy/sell tax, mint authority, liquidity presence & lock, ownership renouncement, top-10 holder concentration, " +
        "known malicious/drain patterns), a plain-language explanation, a confidence level, and which data sources were " +
        "reachable. Call this BEFORE swapping into or approving any token. Stateless and idempotent. " +
        `Supported chains: ${supportedChainsSummary().map((c) => `${c.name}(${c.id})`).join(", ")}.`,
      inputSchema: {
        chain: z
          .union([z.number().int().positive(), z.string().min(1)])
          .optional()
          .describe("Chain id (e.g. 1) or name/alias (e.g. 'ethereum', 'bsc', 'base'). Defaults to Ethereum."),
        token_address: z
          .string()
          .describe("Token/contract address to assess (0x-prefixed, 40 hex chars)."),
      },
    },
    async (args) => {
      const result = await assessTokenRisk(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
        isError: result.ok === false,
      };
    },
  );

  return server;
}
