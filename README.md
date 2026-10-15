# lubelogger-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude log service, repair, upgrade, fuel and odometer records into your self-hosted [LubeLogger](https://github.com/hargata/lubelog).

You send Claude a photo or PDF of an invoice or receipt. Claude reads it, extracts the fields, shows you a preview, and after you confirm, writes the record to LubeLogger.

The server does **no** OCR or document parsing. Claude already reads images and PDFs, so the server is a thin, typed, validated wrapper over the LubeLogger API.

## How it works

```
photo/PDF  ->  Claude reads it  ->  propose_* tool  ->  PREVIEW + warnings + token
                                                              |
                                      you confirm in chat  <--'
                                              |
                                      commit_record(token)  ->  LubeLogger API
```

- **Nothing is written by a `propose_*` tool.** It validates, resolves the vehicle, compares against the latest odometer, checks for duplicates, and stores the exact payload under a single-use token (default 30 min).
- **`commit_record` writes exactly what was previewed**, not re-derived input.
- **Odometer is required on every record.** Receipts usually lack it, so Claude asks you for it, typed or as a photo of the dashboard.

## Tools

| Tool | Purpose |
|---|---|
| `list_vehicles` | Vehicles with ids and latest odometer |
| `get_latest_odometer` | Latest odometer for one vehicle |
| `propose_service_record` | Service, repair or upgrade record (`recordType`), from an invoice or work order |
| `propose_fuel_record` | Fuel or EV charge, from a receipt (supports partial fills, missed fill-ups, EV state of charge) |
| `propose_odometer_record` | Standalone odometer reading (e.g. from a dashboard photo) |
| `commit_record` | Save a previously proposed record by token |

Vehicles can be referenced by id or any part of the name/plate (`tacoma`, `ABC123`). If a name matches more than one vehicle, the tool errors and Claude asks you.

### Warnings shown in previews

- Odometer lower than the latest reading on file (likely misread), or an unusually large jump (extra digit)
- Possible duplicate (same date and same odometer or cost, for that record type)
- Date in the future
- Fuel: implausible price per unit or quantity (amount/cost swapped, wrong units)

## Setup

### 1. Create a LubeLogger API key

In LubeLogger, open the user menu and create an API key. The **Editor** role (view, add, edit) is enough. Don't give it Manager.

### 2. Configure

```bash
cp .env.example .env
# fill in LUBELOGGER_API_KEY, and set MCP_AUTH_TOKEN (openssl rand -hex 24)
```

| Variable | Default | Notes |
|---|---|---|
| `LUBELOGGER_URL` | required | Address of LubeLogger as seen from this container, e.g. `http://lubelogger:8080` |
| `LUBELOGGER_API_KEY` | required | Sent as the `x-api-key` header |
| `MCP_AUTH_TOKEN` | unset | If set, every MCP request needs `Authorization: Bearer <token>` |
| `MCP_PATH` | `/mcp` | Use a long random path (e.g. `/mcp/<random>`) if clients can't send a bearer token |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `CONFIRM_TTL_MINUTES` | `30` | How long a preview token stays valid |
| `REQUEST_TIMEOUT_MS` | `15000` | Timeout for LubeLogger calls |

### 3. Run with Docker next to LubeLogger

See `docker-compose.example.yml`. Either add the `lubelogger-mcp` service to your existing LubeLogger compose file (simplest, then `LUBELOGGER_URL=http://lubelogger:8080` works as-is), or attach it to LubeLogger's network.

```bash
docker compose up -d --build
curl http://localhost:3000/healthz   # {"status":"ok"}
```

Without Docker: `npm ci && npm run build && npm start` (Node 20+).

### 4. Connect Claude

**Claude Code** (works for anything on your LAN or Tailscale):

```bash
claude mcp add --transport http lubelogger http://<server>:3000/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**Claude app / claude.ai custom connector:** as far as I know, remote connectors are called from Anthropic's cloud, not from your phone or LAN. That means the URL must be reachable over public HTTPS (reverse proxy, Cloudflare Tunnel, Tailscale Funnel). The connector UI also doesn't take a static bearer header (it supports OAuth or none). So for this route, set `MCP_PATH` to a long random path and treat that URL as a secret. Check Anthropic's current connector docs before relying on this, since it changes.

## Security notes

- This server holds an API key that can add records to your LubeLogger. Don't expose it unauthenticated. Use `MCP_AUTH_TOKEN`, a secret `MCP_PATH`, or keep it LAN/VPN-only.
- The confirm-before-write step is enforced as a two-call flow (propose, then commit with a token). That "the user said yes" is Claude's judgment, guided by the tool descriptions. The Claude app's own tool-approval prompt is a second gate if you leave it on for `commit_record`.
- Costs and amounts are plain numbers in whatever currency and unit LubeLogger is configured for. No conversion happens.

## Limitations

- Add-only. No editing or deleting records (do that in the LubeLogger UI).
- The original invoice/receipt isn't attached to the record. LubeLogger has `/api/documents/upload` and a per-record `files` field, so this is a feasible follow-up.
- Pending previews live in memory, so a container restart drops them (just propose again).
- Tax, reminder and planner records aren't covered yet.
- Written against LubeLogger's published API definition (`wwwroot/defaults/api.json` on `main`) and tested end-to-end against a mock of it. It has **not** been run against a live instance. See the first-run checklist.

## First-run checklist

1. Ask Claude to run `list_vehicles`. You should see both vehicles with their latest odometer.
2. Send a receipt photo for a record you don't mind deleting (or a standalone odometer reading), confirm it, and check it in LubeLogger.
3. Delete the test record in the UI.

If the write fails with 401/403, check the API key role. If vehicles come back empty, the key's user may not have access to them.

## Development

```bash
npm run build
npm test      # builds, then runs an end-to-end smoke test (real server + MCP client + mock LubeLogger)
```

## LubeLogger endpoints used

`GET /api/vehicles`, `GET /api/vehicle/odometerrecords/latest`, `GET /api/vehicle/{servicerecords|repairrecords|upgraderecords|gasrecords|odometerrecords}` (duplicate check), `POST /api/vehicle/{...}/add`. Requests send `x-api-key` and the `culture-invariant` header so numbers and dates are locale-independent.
