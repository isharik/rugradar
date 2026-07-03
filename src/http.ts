/**
 * RugRadar HTTP server — the PUBLIC A2MCP endpoint.
 *
 * This is what gets deployed to a public https:// host and registered on the
 * OKX.AI marketplace as RugRadar's endpoint. It serves three routes:
 *
 *   GET  /            -> service info (name, tool, supported chains, price)
 *   GET  /health      -> liveness probe for the host
 *   POST /assess      -> plain JSON { chain, token_address } convenience/demo API
 *   POST /mcp         -> MCP over Streamable HTTP (stateless) for agent callers
 *
 * Stateless: each /mcp request spins up a fresh server+transport, matching the
 * idempotent nature of the tool and making horizontal scaling trivial.
 *
 * The pay-per-call layer (x402 / OKX Payment SDK) is added in Phase 5 as a
 * middleware in front of /mcp and /assess — this file stays payment-agnostic.
 */
import "./env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRugRadarServer } from "./server.js";
import { assessTokenRisk } from "./assess.js";
import { CONFIG, supportedChainsSummary } from "./config.js";
import { buildChallenge, challengeHeader, getPaymentHeader, paymentsActive } from "./x402.js";

const PORT = Number(process.env.PORT) || CONFIG.httpPort; // hosts inject PORT

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, mcp-session-id, x-payment",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, mcp-session-id, x-payment",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  // Service descriptor / landing.
  if (req.method === "GET" && url === "/") {
    return json(res, 200, {
      service: "RugRadar",
      description: "A2MCP pre-transaction risk oracle. Assess a token before swapping/approving.",
      tool: "assess_token_risk",
      paid_endpoint: "/assess (x402)",
      mcp_endpoint: "/mcp",
      supported_chains: supportedChainsSummary(),
      price_per_call: `${CONFIG.payment.pricePerCall} ${CONFIG.payment.assetSymbol}`,
      pay_to: CONFIG.payment.payTo || "(unset)",
      network: CONFIG.payment.network,
      x402_enabled: paymentsActive(),
    });
  }

  if (req.method === "GET" && url === "/health") {
    return json(res, 200, { ok: true, status: "healthy", ts: new Date().toISOString() });
  }

  // Paid A2MCP endpoint (x402). This is the URL registered on OKX.AI.
  // Discovery probe (any method, no payment) -> 402 challenge.
  // Paid replay (x402 header + POST body) -> assessment.
  if (url === "/assess") {
    const resourceUrl = CONFIG.payment.publicUrl
      ? `${CONFIG.payment.publicUrl.replace(/\/$/, "")}/assess`
      : `http://${req.headers.host ?? "localhost"}/assess`;

    if (paymentsActive() && !getPaymentHeader(req)) {
      const headerB64 = challengeHeader(resourceUrl);
      const text = JSON.stringify(buildChallenge(resourceUrl), null, 2);
      res.writeHead(402, {
        "content-type": "application/json",
        "PAYMENT-REQUIRED": headerB64, // x402 v2
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "PAYMENT-REQUIRED",
      });
      return res.end(text);
    }

    if (req.method !== "POST") {
      return json(res, 405, { ok: false, error: { code: "INVALID_INPUT", message: "Send a POST with JSON { chain?, token_address }." } });
    }
    const body = (await readBody(req)) as Record<string, unknown> | undefined;
    if (!body) return json(res, 400, { ok: false, error: { code: "INVALID_INPUT", message: "Body must be JSON { chain?, token_address }" } });
    const result = await assessTokenRisk(body);
    return json(res, result.ok ? 200 : 400, result);
  }

  // MCP over Streamable HTTP — stateless (fresh server+transport per request).
  if (url === "/mcp") {
    try {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const mcp = createRugRadarServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    } catch (e) {
      if (!res.headersSent) {
        return json(res, 500, { ok: false, error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) } });
      }
      return;
    }
  }

  return json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `No route ${req.method} ${url}` } });
});

server.listen(PORT, () => {
  console.log(
    `RugRadar HTTP listening on :${PORT}  (GET / , GET /health , POST /assess , POST /mcp)  ` +
      `payment_mode=${CONFIG.payment.mode} price=${CONFIG.payment.pricePerCall} USDT`,
  );
});
