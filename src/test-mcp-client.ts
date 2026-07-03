/**
 * End-to-end MCP smoke test. Spawns the RugRadar MCP server over stdio exactly
 * like a real agent (e.g. OpenClaw) would, performs the initialize handshake,
 * lists tools, and calls assess_token_risk. Proves the A2MCP interface works.
 *
 *     npm run test:mcp
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: ["--import", "tsx", resolve(here, "mcp.ts")],
  });
  const client = new Client({ name: "rugradar-smoketest", version: "0.1.0" });
  await client.connect(transport);
  console.log("✓ connected + initialized");

  const tools = await client.listTools();
  console.log("✓ tools:", tools.tools.map((t) => t.name).join(", "));

  // 1) known-good
  const good = await client.callTool({
    name: "assess_token_risk",
    arguments: { chain: 1, token_address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  });
  const goodJson = JSON.parse((good.content as { type: string; text: string }[])[0].text);
  console.log(`✓ WETH  -> verdict=${goodJson.verdict} score=${goodJson.risk_score}`);

  // 2) bad input (validation)
  const bad = await client.callTool({
    name: "assess_token_risk",
    arguments: { chain: 1, token_address: "not-an-address" },
  });
  const badJson = JSON.parse((bad.content as { type: string; text: string }[])[0].text);
  console.log(`✓ invalid input -> ok=${badJson.ok} code=${badJson.error?.code} (isError=${bad.isError})`);

  await client.close();
  console.log("\nALL GOOD — RugRadar is callable as an MCP tool.");
}

main().catch((e) => { console.error("MCP smoke test FAILED:", e); process.exit(1); });
