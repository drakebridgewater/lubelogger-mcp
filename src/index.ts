import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { LubeLoggerClient } from "./lubelogger.js";
import { PendingStore } from "./pending.js";
import { registerTools } from "./tools.js";

const config = loadConfig();
const client = new LubeLoggerClient(config.LUBELOGGER_URL, config.LUBELOGGER_API_KEY, config.REQUEST_TIMEOUT_MS);
const pending = new PendingStore(config.CONFIRM_TTL_MINUTES * 60_000);

const INSTRUCTIONS = [
  "Logs vehicle maintenance and fuel records into LubeLogger from documents you have read.",
  "Workflow: read the invoice/receipt/photo yourself, extract the fields, call the matching propose_* tool, show the preview to the user,",
  "and call commit_record only after they explicitly confirm.",
  "Odometer is required for every record. Receipts often lack it: ask the user (typed value or dashboard photo). Never guess it.",
  "If a vehicle is ambiguous, call list_vehicles and ask.",
].join(" ");

function createServer(): McpServer {
  const server = new McpServer({ name: "lubelogger-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerTools(server, { client, pending, ttlMinutes: config.CONFIRM_TTL_MINUTES });
  return server;
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  const expected = config.MCP_AUTH_TOKEN;
  if (!expected) return next();
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
}

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Stateless Streamable HTTP: a fresh server + transport per request. Pending confirmations live in process memory, so they survive across requests.
app.post(config.MCP_PATH, requireToken, express.json({ limit: "1mb" }), async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err instanceof Error ? err.message : err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)." }, id: null });
};
app.get(config.MCP_PATH, requireToken, methodNotAllowed);
app.delete(config.MCP_PATH, requireToken, methodNotAllowed);

const httpServer = app.listen(config.PORT, config.HOST, () => {
  console.error(`lubelogger-mcp listening on http://${config.HOST}:${config.PORT}${config.MCP_PATH}`);
  console.error(`LubeLogger: ${config.LUBELOGGER_URL}`);
  if (!config.MCP_AUTH_TOKEN && config.MCP_PATH === "/mcp") {
    console.error("WARNING: no MCP_AUTH_TOKEN set and MCP_PATH is the default. Anyone who can reach this port can write to LubeLogger.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
