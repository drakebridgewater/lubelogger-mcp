import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LubeLoggerError,
  resolveVehicle,
  vehicleLabel,
  type LubeLoggerClient,
  type RecordKind,
} from "./lubelogger.js";
import type { PendingStore } from "./pending.js";

interface Deps {
  client: LubeLoggerClient;
  pending: PendingStore;
  ttlMinutes: number;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] });

async function guard(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const KIND_LABEL: Record<RecordKind, string> = {
  service: "Service record",
  repair: "Repair record",
  upgrade: "Upgrade record",
  fuel: "Fuel record",
  odometer: "Odometer record",
};

// ---------- shared input fields ----------

function isRealDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const vehicleField = z
  .union([z.string().min(1), z.number().int()])
  .describe("Vehicle id, or any part of its name/plate (e.g. 'tacoma' or 'ABC123'). Call list_vehicles if unsure.");

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isRealDate, "Not a real calendar date")
  .describe("Date the work or fill-up happened, YYYY-MM-DD. Use the date on the document, not today's date.");

const odometerField = z
  .number()
  .int()
  .min(0)
  .max(2_000_000)
  .describe(
    "Odometer reading, in the unit LubeLogger is configured for. REQUIRED. If the document doesn't show it, ask the user to type it " +
      "or send a photo of the dashboard. Never guess, and never reuse the last known reading.",
  );

const moneyField = z.number().min(0).max(1_000_000);
const tagsField = z.string().max(200).optional().describe("Space-separated tags, e.g. 'oil-change dealer'.");
const notesField = z.string().max(4000).optional();
const extraFieldsField = z
  .array(z.object({ name: z.string().min(1), value: z.string() }))
  .optional()
  .describe("Only for extra fields the user has configured in LubeLogger. Names must match exactly.");

// ---------- helpers ----------

function normDate(raw: unknown): string | null {
  const s = String(raw ?? "");
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1]!;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function num(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  const n = Number(s.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const daysBetween = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86_400_000;

function findDuplicates(records: Record<string, unknown>[], date: string, odometer: number, cost?: number): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (normDate(r.date) !== date) continue;
    const rCost = num(r.cost);
    const sameOdo = num(r.odometer) === odometer;
    const sameCost = cost !== undefined && rCost !== null && Math.abs(rCost - cost) < 0.005;
    if (sameOdo || sameCost) {
      const desc = r.description ? ` "${String(r.description).slice(0, 60)}"` : "";
      out.push(`existing record id ${String(r.id ?? "?")}${desc}, odometer ${String(r.odometer ?? "?")}, cost ${String(r.cost ?? "?")}`);
    }
  }
  return out;
}

interface PreviewArgs {
  deps: Deps;
  vehicleQuery: string | number;
  kind: RecordKind;
  date: string;
  odometer: number;
  cost?: number;
  details: [string, string][];
  extraWarnings?: string[];
  buildBody: (latestOdometer: number | null) => Record<string, unknown>;
}

async function buildPreview(a: PreviewArgs): Promise<string> {
  const { client, pending, ttlMinutes } = a.deps;
  const vehicles = await client.listVehicles();
  const vehicle = resolveVehicle(vehicles, a.vehicleQuery);
  const warnings: string[] = [...(a.extraWarnings ?? [])];

  let latest: number | null = null;
  try {
    latest = await client.getLatestOdometer(vehicle.id);
  } catch (err) {
    warnings.push(`Could not read the latest odometer for comparison (${err instanceof Error ? err.message : String(err)}).`);
  }

  if (latest !== null && a.odometer < latest) {
    warnings.push(
      `Odometer ${fmt(a.odometer)} is LOWER than the latest reading on file (${fmt(latest)}). Likely a misread or typo; confirm with the user. ` +
        `(If this is a genuine back-dated entry, that's fine.)`,
    );
  }
  if (latest !== null && a.odometer - latest > 25_000) {
    warnings.push(`Odometer jumps ${fmt(a.odometer - latest)} from the latest reading (${fmt(latest)}). Double-check for an extra digit.`);
  }

  const today = new Date().toISOString().slice(0, 10);
  if (daysBetween(a.date, today) > 1) warnings.push(`Date ${a.date} is in the future.`);

  try {
    const dupes = findDuplicates(await client.listRecords(a.kind, vehicle.id), a.date, a.odometer, a.cost);
    for (const d of dupes) warnings.push(`Possible duplicate: ${d}.`);
  } catch {
    warnings.push("Could not check for duplicate records.");
  }

  const rec = pending.add({
    kind: a.kind,
    vehicleId: vehicle.id,
    vehicleLabel: vehicleLabel(vehicle),
    body: a.buildBody(latest),
  });

  const lines = [
    `PREVIEW: nothing has been saved yet.`,
    ``,
    `- Type: ${KIND_LABEL[a.kind]}`,
    `- Vehicle: ${vehicleLabel(vehicle)} [id ${vehicle.id}]`,
    ...a.details.map(([k, v]) => `- ${k}: ${v}`),
    `- Latest odometer on file: ${latest === null ? "none" : fmt(latest)}`,
  ];
  if (warnings.length) lines.push(``, `Warnings:`, ...warnings.map((w) => `- ${w}`));
  lines.push(
    ``,
    `Confirmation token: ${rec.token} (valid for ${ttlMinutes} minutes, single use)`,
    ``,
    `NEXT STEP: show this preview to the user and ask them to confirm or correct it. Call commit_record with the token ONLY after they explicitly confirm. ` +
      `If they want changes, call the propose tool again with corrected values.`,
  );
  return lines.join("\n");
}

// ---------- tool registration ----------

export function registerTools(server: McpServer, deps: Deps): void {
  const { client, pending } = deps;

  server.registerTool(
    "list_vehicles",
    {
      title: "List vehicles",
      description: "List the vehicles in LubeLogger with their ids and latest known odometer reading.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const vehicles = await client.listVehicles();
        if (!vehicles.length) return "No vehicles found.";
        const rows = await Promise.all(
          vehicles.map(async (v) => {
            const odo = await client.getLatestOdometer(v.id).catch(() => null);
            return `- id ${v.id}: ${vehicleLabel(v)}, latest odometer: ${odo === null ? "none" : fmt(odo)}`;
          }),
        );
        return rows.join("\n");
      }),
  );

  server.registerTool(
    "get_latest_odometer",
    {
      title: "Get latest odometer",
      description: "Get the latest odometer reading LubeLogger has for a vehicle (across all record types).",
      inputSchema: { vehicle: vehicleField },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ vehicle }) =>
      guard(async () => {
        const v = resolveVehicle(await client.listVehicles(), vehicle);
        const odo = await client.getLatestOdometer(v.id);
        return `${vehicleLabel(v)} [id ${v.id}]: latest odometer ${odo === null ? "none recorded" : fmt(odo)}`;
      }),
  );

  server.registerTool(
    "propose_service_record",
    {
      title: "Propose service/repair/upgrade record",
      description:
        "Prepare a maintenance record from an invoice, receipt or work order that you have already read (image or PDF). " +
        "Nothing is saved: returns a preview with warnings and a confirmation token. " +
        "recordType: 'service' = scheduled maintenance (oil, filters, tires, brakes); 'repair' = unplanned fix; 'upgrade' = enhancement. " +
        "Put the shop name and a parts/labor breakdown in notes. Odometer is required; ask the user if the document lacks it.",
      inputSchema: {
        vehicle: vehicleField,
        recordType: z.enum(["service", "repair", "upgrade"]).default("service"),
        date: dateField,
        odometer: odometerField,
        description: z.string().min(1).max(200).describe("Short summary, e.g. 'Oil and filter change'."),
        cost: moneyField.describe("Total cost as a plain number (no currency symbol). Use the invoice total."),
        notes: notesField.describe("Shop name, parts, labor, invoice number, warranty info."),
        tags: tagsField,
        extraFields: extraFieldsField,
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(() =>
        buildPreview({
          deps,
          vehicleQuery: args.vehicle,
          kind: args.recordType,
          date: args.date,
          odometer: args.odometer,
          cost: args.cost,
          details: [
            ["Date", args.date],
            ["Odometer", fmt(args.odometer)],
            ["Description", args.description],
            ["Cost", args.cost.toFixed(2)],
            ["Notes", args.notes || "(none)"],
            ["Tags", args.tags || "(none)"],
            ...(args.extraFields?.length ? ([["Extra fields", args.extraFields.map((f) => `${f.name}=${f.value}`).join(", ")]] as [string, string][]) : []),
          ],
          buildBody: () => ({
            date: args.date,
            odometer: args.odometer,
            description: args.description,
            cost: args.cost,
            notes: args.notes ?? "",
            tags: args.tags ?? "",
            ...(args.extraFields?.length ? { extraFields: args.extraFields } : {}),
          }),
        }),
      ),
  );

  server.registerTool(
    "propose_fuel_record",
    {
      title: "Propose fuel record",
      description:
        "Prepare a fuel (or EV charging) record from a pump/charger receipt that you have already read. Nothing is saved: returns a preview " +
        "with a confirmation token. Odometer is required and is usually NOT on the receipt: ask the user, or have them send a dashboard photo. " +
        "fuelConsumed is in the unit LubeLogger is configured for (gallons or liters; kWh for EVs). Set isFillToFull=false for partial fills, " +
        "missedFuelUp=true if an earlier fill-up was never logged.",
      inputSchema: {
        vehicle: vehicleField,
        date: dateField,
        odometer: odometerField,
        fuelConsumed: z.number().positive().max(10_000).describe("Amount of fuel/energy added."),
        cost: moneyField.describe("Total cost as a plain number."),
        isFillToFull: z.boolean().default(true),
        missedFuelUp: z.boolean().default(false),
        startingSoc: z.number().int().min(0).max(100).optional().describe("EV only: state of charge % before charging."),
        endingSoc: z.number().int().min(0).max(100).optional().describe("EV only: state of charge % after charging."),
        notes: notesField.describe("Station name, fuel grade, etc."),
        tags: tagsField,
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const unitPrice = args.cost / args.fuelConsumed;
      const extraWarnings: string[] = [];
      if (unitPrice > 20) extraWarnings.push(`Price per unit works out to ${unitPrice.toFixed(2)}. Check that fuel amount and cost weren't swapped.`);
      if (args.fuelConsumed > 150) extraWarnings.push(`${fmt(args.fuelConsumed)} units of fuel is unusually large. Check the units.`);
      return guard(() =>
        buildPreview({
          deps,
          vehicleQuery: args.vehicle,
          kind: "fuel",
          date: args.date,
          odometer: args.odometer,
          cost: args.cost,
          extraWarnings,
          details: [
            ["Date", args.date],
            ["Odometer", fmt(args.odometer)],
            ["Fuel consumed", fmt(args.fuelConsumed)],
            ["Cost", `${args.cost.toFixed(2)} (${unitPrice.toFixed(3)} per unit)`],
            ["Filled to full", args.isFillToFull ? "yes" : "no (partial)"],
            ["Missed earlier fill-up", args.missedFuelUp ? "yes" : "no"],
            ...(args.startingSoc !== undefined || args.endingSoc !== undefined
              ? ([["State of charge", `${args.startingSoc ?? "?"}% to ${args.endingSoc ?? "?"}%`]] as [string, string][])
              : []),
            ["Notes", args.notes || "(none)"],
            ["Tags", args.tags || "(none)"],
          ],
          buildBody: () => ({
            date: args.date,
            odometer: args.odometer,
            fuelConsumed: args.fuelConsumed,
            cost: args.cost,
            isFillToFull: args.isFillToFull,
            missedFuelUp: args.missedFuelUp,
            ...(args.startingSoc !== undefined ? { startingSoc: args.startingSoc } : {}),
            ...(args.endingSoc !== undefined ? { endingSoc: args.endingSoc } : {}),
            notes: args.notes ?? "",
            tags: args.tags ?? "",
          }),
        }),
      );
    },
  );

  server.registerTool(
    "propose_odometer_record",
    {
      title: "Propose odometer record",
      description:
        "Prepare a standalone odometer reading (e.g. read from a dashboard photo). Nothing is saved: returns a preview with a confirmation token.",
      inputSchema: {
        vehicle: vehicleField,
        date: dateField,
        odometer: odometerField,
        notes: notesField,
        tags: tagsField,
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(() =>
        buildPreview({
          deps,
          vehicleQuery: args.vehicle,
          kind: "odometer",
          date: args.date,
          odometer: args.odometer,
          details: [
            ["Date", args.date],
            ["Odometer", fmt(args.odometer)],
            ["Notes", args.notes || "(none)"],
            ["Tags", args.tags || "(none)"],
          ],
          buildBody: (latest) => ({
            date: args.date,
            // LubeLogger stores the previous reading to compute distance traveled.
            initialOdometer: latest !== null && latest <= args.odometer ? latest : args.odometer,
            odometer: args.odometer,
            notes: args.notes ?? "",
            tags: args.tags ?? "",
          }),
        }),
      ),
  );

  server.registerTool(
    "commit_record",
    {
      title: "Save confirmed record",
      description:
        "Write a previously proposed record to LubeLogger. ONLY call this after the user has seen the preview and explicitly confirmed it in chat. " +
        "Takes the confirmation token from a propose_* tool. Saves exactly what the preview showed.",
      inputSchema: { confirmationToken: z.string().min(1).describe("Token returned by a propose_* tool.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ confirmationToken }) =>
      guard(async () => {
        const rec = pending.take(confirmationToken);
        if (!rec) {
          throw new Error("Unknown or expired confirmation token. Run the propose_* tool again and re-confirm with the user.");
        }
        try {
          const res = await client.addRecord(rec.kind, rec.vehicleId, rec.body);
          return `Saved ${KIND_LABEL[rec.kind].toLowerCase()} for ${rec.vehicleLabel}. LubeLogger: ${res.message ?? "OK"}`;
        } catch (err) {
          // Definite rejection: nothing was written, so allow a retry with the same token.
          if (err instanceof LubeLoggerError && err.definitive) pending.restore(rec);
          throw err;
        }
      }),
  );
}
