/**
 * RugRadar HTTP server — the PUBLIC A2MCP endpoint.
 *
 * This is what gets deployed to a public https:// host and registered on the
 * OKX.AI marketplace as RugRadar's endpoint. It serves:
 *
 *   GET  /            -> service info (name, tool, supported chains, price)
 *   GET  /health      -> liveness probe for the host
 *   POST /assess      -> the PAID A2MCP endpoint, protected by the real OKX
 *                         x402 SDK (@okxweb3/x402-*). Unpaid requests get a
 *                         standards-compliant 402 challenge issued AND verified
 *                         by OKX's hosted facilitator; only a genuinely valid,
 *                         signed payment reaches the handler below.
 *   ALL  /mcp         -> MCP over Streamable HTTP (stateless) for agent callers
 *
 * Why the OKX SDK and not a hand-rolled 402: a resource server must actually
 * VERIFY the signed payment authorization (via OKX's facilitator) before
 * granting access — checking "is some header present" is not sufficient and
 * fails OKX's x402 standard validation. The SDK below performs real
 * verify + settle against OKX's hosted facilitator on X Layer.
 */
import "./env.js";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRugRadarServer } from "./server.js";
import { assessTokenRisk } from "./assess.js";
import { CONFIG, supportedChainsSummary } from "./config.js";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402ResourceServer, x402HTTPResourceServer, paymentMiddlewareFromHTTPServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

const PORT = Number(process.env.PORT) || CONFIG.httpPort; // hosts inject PORT

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, mcp-session-id, x-payment, payment-signature");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  next();
});
app.options(/.*/, (_req, res) => res.sendStatus(204));

// --- Landing / health --------------------------------------------------
app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "RugRadar",
    description: "A2MCP pre-transaction risk oracle. Assess a token before swapping/approving.",
    tool: "assess_token_risk",
    paid_endpoint: "/assess (x402, OKX Payment SDK)",
    mcp_endpoint: "/mcp",
    supported_chains: supportedChainsSummary(),
    price_per_call: `${CONFIG.payment.pricePerCall} ${CONFIG.payment.assetSymbol}`,
    pay_to: CONFIG.payment.payTo || "(unset)",
    network: CONFIG.payment.network,
    x402_enabled: paymentsConfigured(),
  });
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, status: "healthy", ts: new Date().toISOString() });
});

// --- Paid A2MCP endpoint (real OKX x402 SDK) ---------------------------
function paymentsConfigured(): boolean {
  const p = CONFIG.payment;
  return p.enabled && !!p.okxApiKey && !!p.okxSecretKey && !!p.okxPassphrase && !!p.payTo;
}

async function handleAssess(req: Request, res: Response) {
  const result = await assessTokenRisk(req.body ?? {});
  res.status(result.ok ? 200 : 400).json(result);
}

let resourceServerToInitialize: InstanceType<typeof x402ResourceServer> | null = null;

if (paymentsConfigured()) {
  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: CONFIG.payment.okxApiKey,
    secretKey: CONFIG.payment.okxSecretKey,
    passphrase: CONFIG.payment.okxPassphrase,
    syncSettle: true, // wait for on-chain confirmation before delivering the verdict
  });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    "eip155:196",
    new ExactEvmScheme(),
  );
  resourceServerToInitialize = resourceServer;

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "POST /assess": {
      description: "RugRadar assess_token_risk — pre-transaction token risk verdict",
      mimeType: "application/json",
      accepts: {
        scheme: "exact",
        network: "eip155:196",
        payTo: CONFIG.payment.payTo,
        price: `$${CONFIG.payment.pricePerCall}`,
        maxTimeoutSeconds: 300,
      },
    },
  });

  app.use(paymentMiddlewareFromHTTPServer(httpServer));
  app.post("/assess", handleAssess);
} else {
  // Payments not configured (missing OKX credentials or disabled). Fail closed
  // rather than silently serving the paid resource for free.
  app.post("/assess", (_req: Request, res: Response) => {
    res.status(503).json({
      ok: false,
      error: {
        code: "PAYMENTS_NOT_CONFIGURED",
        message:
          "The paid A2MCP endpoint is not configured on this deployment (missing OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE / PAY_TO).",
      },
    });
  });
  console.warn(
    "[RugRadar] Payments NOT configured — POST /assess will return 503. " +
      "Set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE and PAY_TO to enable the real x402 endpoint.",
  );
}

// --- MCP over Streamable HTTP — stateless (fresh server+transport per request) ---
app.all("/mcp", async (req: Request, res: Response) => {
  try {
    const mcp = createRugRadarServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.method === "GET" ? undefined : req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) } });
    }
  }
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: `No route ${req.method} ${req.path}` } });
});

app.listen(PORT, async () => {
  console.log(
    `RugRadar HTTP listening on :${PORT}  (GET / , GET /health , POST /assess , ALL /mcp)  ` +
      `payment_mode=${CONFIG.payment.mode} price=${CONFIG.payment.pricePerCall} ${CONFIG.payment.assetSymbol} ` +
      `x402_configured=${paymentsConfigured()}`,
  );
  // MUST run after the server starts, before any request is handled. Guarded so
  // a facilitator/credential error can't crash the whole process (Render keeps
  // /health passing; only /assess would fail on real requests).
  if (resourceServerToInitialize) {
    try {
      await resourceServerToInitialize.initialize();
      console.log("[RugRadar] OKX x402 resource server initialized.");
    } catch (e) {
      console.error(
        "[RugRadar] OKX x402 resource server FAILED to initialize — check OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE. " +
          "/assess will error until this is fixed and the service restarts.",
        e,
      );
    }
  }
});
