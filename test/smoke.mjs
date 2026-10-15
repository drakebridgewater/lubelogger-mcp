// End-to-end smoke test: real MCP server (dist/) + real MCP client + mock LubeLogger.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const API_KEY = "test-api-key";
const AUTH_TOKEN = "test-token-0123456789abcdef";
const MCP_PATH = "/mcp/secretpath";

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---------- mock LubeLogger ----------
const vehicles = [
  { id: 1, year: 2019, make: "Toyota", model: "Tacoma", licensePlate: "ABC123" },
  { id: 2, year: 2015, make: "Toyota", model: "Sienna", licensePlate: "XYZ789" },
];
const latestOdo = { 1: 84900, 2: 120500 };
const existing = {
  servicerecords: { 1: [{ id: 7, date: "2026-10-14", odometer: 84932, description: "Oil change", cost: 89.5 }] },
  // Shaped like LubeLogger 1.7.3: values are strings, dueDate is ToShortDateString() in the invariant culture.
  reminders: {
    1: [
      {
        id: "3",
        description: "Rotate Tires",
        urgency: "NotUrgent",
        metric: "Both",
        dueDate: "04/15/2027",
        dueOdometer: "92000",
        dueDays: "182",
        dueDistance: "7100",
        notes: "Every 6k",
        tags: "tires",
      },
      {
        id: "4",
        description: "Replace wiper blades",
        urgency: "PastDue",
        metric: "Date",
        dueDate: "09/01/2026",
        dueOdometer: "0",
        dueDays: "-44",
        dueDistance: "0",
        notes: "",
        tags: "",
      },
    ],
  },
};
const posts = []; // { method, path, vehicleId, body }

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, "http://mock");
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (req.headers["x-api-key"] !== API_KEY) return send(401, { success: false, message: "Unauthorized" });
  const vehicleId = Number(url.searchParams.get("vehicleId"));

  if (req.method === "GET" && url.pathname === "/api/vehicles") return send(200, vehicles);
  if (req.method === "GET" && url.pathname === "/api/vehicle/odometerrecords/latest") return send(200, latestOdo[vehicleId] ?? 0);
  const m = url.pathname.match(/^\/api\/vehicle\/(\w+)(\/add)?$/);
  if (m && req.method === "GET") return send(200, existing[m[1]]?.[vehicleId] ?? []);
  const write = (message) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      posts.push({ method: req.method, path: url.pathname, vehicleId, body: JSON.parse(raw), contentType: req.headers["content-type"] });
      send(200, { success: true, message });
    });
  };
  if (m && m[2] && req.method === "POST") return write("Record Added");
  // The real update endpoint is PUT-only; POST returns 405.
  if (url.pathname === "/api/vehicle/reminders/update") {
    return req.method === "PUT" ? write("Reminder Record Updated") : send(405, { success: false, message: "Method Not Allowed" });
  }
  send(404, { success: false, message: "not found" });
});

const text = (r) => r.content.map((c) => c.text).join("\n");
const callOrReject = async (client, name, args) => {
  try {
    const r = await client.callTool({ name, arguments: args });
    return { rejected: Boolean(r.isError), text: text(r) };
  } catch (e) {
    return { rejected: true, text: String(e.message ?? e) };
  }
};
let passed = 0;
const pass = (name) => console.log(`  ok  ${name}`) || passed++;

async function main() {
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = mock.address().port;
  const port = await freePort();

  const server = spawn("node", ["dist/index.js"], {
    env: {
      ...process.env,
      LUBELOGGER_URL: `http://127.0.0.1:${mockPort}`,
      LUBELOGGER_API_KEY: API_KEY,
      MCP_AUTH_TOKEN: AUTH_TOKEN,
      MCP_PATH,
      PORT: String(port),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const base = `http://127.0.0.1:${port}`;

  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(i < 49, "server did not start");
    }
    pass("server starts and /healthz responds");

    // auth
    const noAuth = await fetch(base + MCP_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(noAuth.status, 401);
    pass("rejects requests without the bearer token");

    const client = new Client({ name: "smoke", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + MCP_PATH), { requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } } }),
    );

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      "commit_record",
      "get_latest_odometer",
      "list_reminders",
      "list_vehicles",
      "propose_fuel_record",
      "propose_odometer_record",
      "propose_reminder",
      "propose_reminder_update",
      "propose_service_record",
    ]);
    pass("lists all 9 tools");

    const lv = text(await client.callTool({ name: "list_vehicles", arguments: {} }));
    assert.match(lv, /Tacoma/);
    assert.match(lv, /Sienna/);
    assert.match(lv, /84,900/);
    pass("list_vehicles shows both vehicles with latest odometer");

    // propose -> nothing written, warnings surfaced
    let r = await callOrReject(client, "propose_service_record", {
      vehicle: "tacoma",
      date: "2026-10-14",
      odometer: 84932,
      description: "Oil and filter change",
      cost: 89.5,
      notes: "Jiffy Lube, 5qt 0W-20",
      tags: "oil-change",
    });
    assert.ok(!r.rejected, r.text);
    assert.match(r.text, /PREVIEW/);
    assert.match(r.text, /Possible duplicate/);
    assert.equal(posts.length, 0, "propose must not write");
    pass("propose_service_record previews, flags the duplicate, writes nothing");

    const token = r.text.match(/Confirmation token: ([0-9a-f]+)/)?.[1];
    assert.ok(token, "token present");

    // commit -> exactly one POST with the previewed body
    r = await callOrReject(client, "commit_record", { confirmationToken: token });
    assert.ok(!r.rejected, r.text);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, "/api/vehicle/servicerecords/add");
    assert.equal(posts[0].vehicleId, 1);
    assert.match(posts[0].contentType, /application\/json/);
    assert.deepEqual(posts[0].body, {
      date: "2026-10-14",
      odometer: 84932,
      description: "Oil and filter change",
      cost: 89.5,
      notes: "Jiffy Lube, 5qt 0W-20",
      tags: "oil-change",
    });
    pass("commit_record writes exactly the previewed body (numbers stay numbers)");

    // single use
    r = await callOrReject(client, "commit_record", { confirmationToken: token });
    assert.ok(r.rejected);
    assert.equal(posts.length, 1);
    pass("token is single-use");

    r = await callOrReject(client, "commit_record", { confirmationToken: "deadbeef" });
    assert.ok(r.rejected);
    pass("unknown token is rejected");

    // lower odometer warning, vehicle matched by plate, repair type routing
    r = await callOrReject(client, "propose_service_record", {
      vehicle: "xyz789",
      recordType: "repair",
      date: "2026-10-10",
      odometer: 100000,
      description: "Alternator",
      cost: 420,
    });
    assert.ok(!r.rejected, r.text);
    assert.match(r.text, /Sienna/);
    assert.match(r.text, /LOWER than the latest/);
    const repairToken = r.text.match(/Confirmation token: ([0-9a-f]+)/)[1];
    await client.callTool({ name: "commit_record", arguments: { confirmationToken: repairToken } });
    assert.equal(posts.at(-1).path, "/api/vehicle/repairrecords/add");
    assert.equal(posts.at(-1).vehicleId, 2);
    pass("matches vehicle by plate, warns on lower odometer, routes repair records");

    // ambiguous vehicle
    r = await callOrReject(client, "propose_fuel_record", { vehicle: "toyota", date: "2026-10-15", odometer: 85000, fuelConsumed: 12, cost: 40 });
    assert.ok(r.rejected);
    assert.match(r.text, /more than one vehicle/);
    pass("ambiguous vehicle asks instead of guessing");

    // validation: bad date, missing odometer
    r = await callOrReject(client, "propose_fuel_record", { vehicle: 1, date: "2026-13-45", odometer: 85000, fuelConsumed: 12, cost: 40 });
    assert.ok(r.rejected);
    r = await callOrReject(client, "propose_service_record", { vehicle: 1, date: "2026-10-14", description: "x", cost: 1 });
    assert.ok(r.rejected);
    pass("rejects invalid dates and a missing odometer");

    // fuel flow
    r = await callOrReject(client, "propose_fuel_record", {
      vehicle: "tacoma",
      date: "2026-10-15",
      odometer: 85210,
      fuelConsumed: 14.25,
      cost: 52.3,
      notes: "Shell",
    });
    assert.ok(!r.rejected, r.text);
    await client.callTool({ name: "commit_record", arguments: { confirmationToken: r.text.match(/Confirmation token: ([0-9a-f]+)/)[1] } });
    assert.equal(posts.at(-1).path, "/api/vehicle/gasrecords/add");
    assert.equal(posts.at(-1).body.isFillToFull, true);
    assert.equal(posts.at(-1).body.missedFuelUp, false);
    assert.equal(posts.at(-1).body.fuelConsumed, 14.25);
    pass("fuel record flow (defaults: filled to full, not missed)");

    // odometer flow: initialOdometer = previous latest
    r = await callOrReject(client, "propose_odometer_record", { vehicle: "tacoma", date: "2026-10-15", odometer: 85300 });
    assert.ok(!r.rejected, r.text);
    await client.callTool({ name: "commit_record", arguments: { confirmationToken: r.text.match(/Confirmation token: ([0-9a-f]+)/)[1] } });
    assert.equal(posts.at(-1).path, "/api/vehicle/odometerrecords/add");
    assert.equal(posts.at(-1).body.initialOdometer, 84900);
    assert.equal(posts.at(-1).body.odometer, 85300);
    pass("odometer record sets initialOdometer from the latest reading");

    // ---------- reminders ----------
    const tokenOf = (t) => t.match(/Confirmation token: ([0-9a-f]+)/)?.[1];

    r = await callOrReject(client, "list_reminders", { vehicle: "tacoma" });
    assert.ok(!r.rejected, r.text);
    assert.match(r.text, /id 3: Rotate Tires \[NotUrgent\]/);
    assert.match(r.text, /2027-04-15 or at 92,000/);
    assert.match(r.text, /182 days \/ 7,100 distance left/);
    assert.match(r.text, /id 4: Replace wiper blades \[PastDue\]/);
    r = await callOrReject(client, "list_reminders", { vehicle: "sienna" });
    assert.match(r.text, /no reminders/);
    pass("list_reminders shows id, urgency, due point and what's left");

    // metric/due-field validation
    r = await callOrReject(client, "propose_reminder", { vehicle: "tacoma", description: "Brake fluid", metric: "Both", dueDate: "2028-10-01" });
    assert.ok(r.rejected);
    assert.match(r.text, /dueOdometer is required/);
    r = await callOrReject(client, "propose_reminder", { vehicle: "tacoma", description: "Brake fluid", metric: "Date" });
    assert.ok(r.rejected);
    pass("propose_reminder requires the due fields its metric needs");

    // duplicate warning
    const before = posts.length;
    r = await callOrReject(client, "propose_reminder", { vehicle: "tacoma", description: "Tire rotation", metric: "Odometer", dueOdometer: 91000 });
    assert.ok(!r.rejected, r.text);
    assert.match(r.text, /Possible duplicate: existing reminder id 3 "Rotate Tires"/);
    assert.match(r.text, /propose_reminder_update/);
    assert.doesNotMatch(r.text, /Replace wiper/);
    assert.equal(posts.length, before, "propose must not write");
    pass("propose_reminder warns about a similar existing reminder, writes nothing");

    // add
    r = await callOrReject(client, "propose_reminder", {
      vehicle: "tacoma",
      description: "Replace tires",
      metric: "Both",
      dueDate: "2031-10-01",
      dueOdometer: 145000,
      notes: "Michelin Defender LTX, 60k warranty",
      tags: "tires",
    });
    assert.ok(!r.rejected, r.text);
    assert.doesNotMatch(r.text, /Possible duplicate/);
    r = await callOrReject(client, "commit_record", { confirmationToken: tokenOf(r.text) });
    assert.ok(!r.rejected, r.text);
    assert.match(r.text, /Saved new reminder/);
    assert.equal(posts.at(-1).method, "POST");
    assert.equal(posts.at(-1).path, "/api/vehicle/reminders/add");
    assert.equal(posts.at(-1).vehicleId, 1);
    assert.deepEqual(posts.at(-1).body, {
      description: "Replace tires",
      metric: "Both",
      dueDate: "2031-10-01",
      dueOdometer: 145000,
      notes: "Michelin Defender LTX, 60k warranty",
      tags: "tires",
    });
    pass("propose_reminder + commit_record POSTs the previewed reminder");

    // update: unknown id
    r = await callOrReject(client, "propose_reminder_update", { vehicle: "tacoma", reminderId: 99, dueOdometer: 98000 });
    assert.ok(r.rejected);
    assert.match(r.text, /no reminder with id 99/);
    assert.match(r.text, /id 3: Rotate Tires/);
    pass("propose_reminder_update rejects an unknown id and lists the real ones");

    // update: move rotation forward, keep everything else
    r = await callOrReject(client, "propose_reminder_update", { vehicle: "tacoma", reminderId: "3", dueDate: "2027-10-15", dueOdometer: 98000 });
    assert.ok(!r.rejected, r.text);
    assert.match(r.text, /on 2027-04-15 or at 92,000, whichever comes first -> on 2027-10-15 or at 98,000/);
    assert.match(r.text, /Description: Rotate Tires$/m);
    r = await callOrReject(client, "commit_record", { confirmationToken: tokenOf(r.text) });
    assert.ok(!r.rejected, r.text);
    assert.equal(posts.at(-1).method, "PUT");
    assert.equal(posts.at(-1).path, "/api/vehicle/reminders/update");
    assert.deepEqual(posts.at(-1).body, {
      id: 3,
      description: "Rotate Tires",
      metric: "Both",
      dueDate: "2027-10-15",
      dueOdometer: 98000,
      notes: "Every 6k",
      tags: "tires",
    });
    pass("propose_reminder_update PUTs the full merged reminder");

    // update keeps the unused due field, flags no-op and past-due values
    r = await callOrReject(client, "propose_reminder_update", { vehicle: "tacoma", reminderId: 4, metric: "Odometer", dueOdometer: 80000 });
    assert.ok(!r.rejected, r.text);
    assert.match(r.text, /at or below the latest reading/);
    await client.callTool({ name: "commit_record", arguments: { confirmationToken: tokenOf(r.text) } });
    assert.equal(posts.at(-1).body.dueDate, "2026-09-01");
    assert.equal(posts.at(-1).body.dueOdometer, 80000);
    r = await callOrReject(client, "propose_reminder_update", { vehicle: "tacoma", reminderId: 3 });
    assert.match(r.text, /Nothing changes/);
    pass("update preserves the unused due field and warns on past-due / no-op changes");

    await client.close();
    console.log(`\n${passed} checks passed`);
  } finally {
    server.kill();
    mock.close();
  }
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err);
  process.exit(1);
});
