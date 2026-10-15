import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveVehicle, vehicleLabel, type Reminder, type ReminderMetric } from "./lubelogger.js";
import { fmt, guard, isRealDate, normDate, notesField, num, tagsField, vehicleField, type Deps } from "./tools.js";

// ---------- input fields ----------

const metricField = z
  .enum(["Date", "Odometer", "Both"])
  .describe("What triggers the reminder: 'Date', 'Odometer', or 'Both' (whichever comes first).");

const dueDateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine(isRealDate, "Not a real calendar date")
  .describe("Due date, YYYY-MM-DD. Required when metric is 'Date' or 'Both'.");

const dueOdometerField = z
  .number()
  .int()
  .min(0)
  .max(2_000_000)
  .describe("Odometer reading the reminder is due at, in LubeLogger's unit. Required when metric is 'Odometer' or 'Both'.");

const reminderTagsField = tagsField.describe("Space-separated tags, e.g. 'tires'.");
const reminderNotesField = notesField.describe("Details, e.g. tire size, interval used, shop.");

// ---------- helpers ----------

/**
 * LubeLogger formats dueDate with ToShortDateString(), so it may be ISO or MM/dd/yyyy (invariant culture).
 * Returns YYYY-MM-DD when recognisable, otherwise null.
 */
function reminderDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    const iso = `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
    return isRealDate(iso) ? iso : null;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? normDate(s) : null;
}

const STOPWORDS = new Set(["a", "an", "and", "the", "of", "for", "to", "on", "in", "at", "my"]);

/** Word stems (first 4 letters) so "Rotate Tires" and "Tire rotation" compare equal. */
function stems(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOPWORDS.has(t))
      .map((t) => t.slice(0, 4)),
  );
}

/** True when every meaningful word of the shorter description appears in the other. */
function similarDescription(a: string, b: string): boolean {
  const A = stems(a);
  const B = stems(b);
  if (!A.size || !B.size) return false;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  return [...small].every((t) => big.has(t));
}

function describeDue(metric: string, dueDate: string | null, dueOdometer: number | null): string {
  const date = dueDate ?? "?";
  const odo = dueOdometer === null ? "?" : fmt(dueOdometer);
  if (metric === "Date") return `on ${date}`;
  if (metric === "Odometer") return `at ${odo}`;
  return `on ${date} or at ${odo}, whichever comes first`;
}

function reminderLine(r: Reminder): string {
  const metric = String(r.metric ?? "?");
  const parts = [`- id ${String(r.id)}: ${String(r.description ?? "(no description)")} [${String(r.urgency ?? "?")}]`];
  parts.push(`due ${describeDue(metric, reminderDate(r.dueDate) ?? (r.dueDate ? String(r.dueDate) : null), num(r.dueOdometer))}`);
  const left: string[] = [];
  const days = num(r.dueDays);
  const dist = num(r.dueDistance);
  if (metric !== "Odometer" && days !== null) left.push(`${fmt(days)} days`);
  if (metric !== "Date" && dist !== null) left.push(`${fmt(dist)} distance`);
  if (left.length) parts.push(`(${left.join(" / ")} left)`);
  if (r.tags) parts.push(`tags: ${String(r.tags)}`);
  if (r.notes) parts.push(`notes: ${String(r.notes).slice(0, 120)}`);
  return parts.join(", ");
}

function checkMetric(metric: ReminderMetric, dueDate: string | null, dueOdometer: number | null): void {
  if (metric !== "Odometer" && !dueDate) throw new Error(`dueDate (YYYY-MM-DD) is required when metric is '${metric}'.`);
  if (metric !== "Date" && dueOdometer === null) throw new Error(`dueOdometer is required when metric is '${metric}'.`);
}

/** Warnings about a due point that is already behind us. */
async function dueWarnings(deps: Deps, vehicleId: number, metric: ReminderMetric, dueDate: string | null, dueOdometer: number | null) {
  const warnings: string[] = [];
  let latest: number | null = null;
  try {
    latest = await deps.client.getLatestOdometer(vehicleId);
  } catch (err) {
    warnings.push(`Could not read the latest odometer for comparison (${err instanceof Error ? err.message : String(err)}).`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (metric !== "Odometer" && dueDate && dueDate < today) warnings.push(`Due date ${dueDate} is in the past, so the reminder will show as past due.`);
  if (metric !== "Date" && dueOdometer !== null && latest !== null && dueOdometer <= latest) {
    warnings.push(`Due odometer ${fmt(dueOdometer)} is at or below the latest reading on file (${fmt(latest)}), so the reminder will show as past due.`);
  }
  return { warnings, latest };
}

function previewText(deps: Deps, token: string, header: string[], warnings: string[]): string {
  const lines = [`PREVIEW: nothing has been saved yet.`, ``, ...header];
  if (warnings.length) lines.push(``, `Warnings:`, ...warnings.map((w) => `- ${w}`));
  lines.push(
    ``,
    `Confirmation token: ${token} (valid for ${deps.ttlMinutes} minutes, single use)`,
    ``,
    `NEXT STEP: show this preview to the user and ask them to confirm or correct it. Call commit_record with the token ONLY after they explicitly confirm. ` +
      `If they want changes, call the propose tool again with corrected values.`,
  );
  return lines.join("\n");
}

// ---------- tool registration ----------

export function registerReminderTools(server: McpServer, deps: Deps): void {
  const { client, pending } = deps;

  server.registerTool(
    "list_reminders",
    {
      title: "List reminders",
      description:
        "List a vehicle's reminders in LubeLogger with id, urgency, what they're due on and how much time/distance is left. " +
        "Call this before proposing a reminder, and to find the id of a reminder to update.",
      inputSchema: { vehicle: vehicleField },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ vehicle }) =>
      guard(async () => {
        const v = resolveVehicle(await client.listVehicles(), vehicle);
        const reminders = await client.listReminders(v.id);
        const head = `${vehicleLabel(v)} [id ${v.id}]`;
        if (!reminders.length) return `${head}: no reminders.`;
        return [`${head}:`, ...reminders.map(reminderLine)].join("\n");
      }),
  );

  server.registerTool(
    "propose_reminder",
    {
      title: "Propose reminder",
      description:
        "Prepare a NEW reminder (e.g. 'Rotate tires' at a date and/or odometer). Nothing is saved: returns a preview with a confirmation token. " +
        "If a similar reminder already exists the preview warns; then offer propose_reminder_update on that reminder instead of creating a duplicate. " +
        "Base due values on the user's request or the service just done (e.g. last rotation odometer + interval); ask if unsure.",
      inputSchema: {
        vehicle: vehicleField,
        description: z.string().min(1).max(200).describe("Short name, e.g. 'Rotate Tires'."),
        metric: metricField,
        dueDate: dueDateField.optional(),
        dueOdometer: dueOdometerField.optional(),
        notes: reminderNotesField,
        tags: reminderTagsField,
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        checkMetric(args.metric, args.dueDate ?? null, args.dueOdometer ?? null);
        const v = resolveVehicle(await client.listVehicles(), args.vehicle);
        const { warnings, latest } = await dueWarnings(deps, v.id, args.metric, args.dueDate ?? null, args.dueOdometer ?? null);

        try {
          for (const r of await client.listReminders(v.id)) {
            if (!similarDescription(args.description, String(r.description ?? ""))) continue;
            warnings.push(
              `Possible duplicate: existing reminder id ${String(r.id)} "${String(r.description)}" [${String(r.urgency ?? "?")}]. ` +
                `Ask the user whether to update it with propose_reminder_update instead of adding a new one.`,
            );
          }
        } catch {
          warnings.push("Could not check for existing reminders.");
        }

        const body: Record<string, unknown> = {
          description: args.description,
          metric: args.metric,
          ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
          ...(args.dueOdometer !== undefined ? { dueOdometer: args.dueOdometer } : {}),
          notes: args.notes ?? "",
          tags: args.tags ?? "",
        };
        const rec = pending.add({ kind: "reminder", vehicleId: v.id, vehicleLabel: vehicleLabel(v), body });
        return previewText(
          deps,
          rec.token,
          [
            `- Type: New reminder`,
            `- Vehicle: ${vehicleLabel(v)} [id ${v.id}]`,
            `- Description: ${args.description}`,
            `- Due: ${describeDue(args.metric, args.dueDate ?? null, args.dueOdometer ?? null)}`,
            `- Notes: ${args.notes || "(none)"}`,
            `- Tags: ${args.tags || "(none)"}`,
            `- Latest odometer on file: ${latest === null ? "none" : fmt(latest)}`,
          ],
          warnings,
        );
      }),
  );

  server.registerTool(
    "propose_reminder_update",
    {
      title: "Propose reminder update",
      description:
        "Prepare a change to an EXISTING reminder, e.g. move 'Rotate Tires' forward after a rotation was done. Get the id from list_reminders. " +
        "Only pass the fields that change; the rest are kept. Nothing is saved: returns a before/after preview with a confirmation token.",
      inputSchema: {
        vehicle: vehicleField,
        reminderId: z.union([z.number().int(), z.string().regex(/^\d+$/)]).describe("Reminder id from list_reminders."),
        description: z.string().min(1).max(200).optional(),
        metric: metricField.optional(),
        dueDate: dueDateField.optional(),
        dueOdometer: dueOdometerField.optional(),
        notes: reminderNotesField.describe("Replaces the existing notes. Pass an empty string to clear."),
        tags: reminderTagsField.describe("Replaces the existing tags. Pass an empty string to clear."),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const v = resolveVehicle(await client.listVehicles(), args.vehicle);
        const reminders = await client.listReminders(v.id);
        const cur = reminders.find((r) => String(r.id) === String(args.reminderId));
        if (!cur) {
          const known = reminders.map((r) => `  - id ${String(r.id)}: ${String(r.description ?? "")}`).join("\n");
          throw new Error(
            `${vehicleLabel(v)} has no reminder with id ${String(args.reminderId)}.` + (known ? ` Its reminders:\n${known}` : " It has no reminders."),
          );
        }

        const curMetric = (["Date", "Odometer", "Both"].includes(String(cur.metric)) ? cur.metric : "Date") as ReminderMetric;
        const curDate = reminderDate(cur.dueDate);
        const curOdo = num(cur.dueOdometer);
        const next = {
          description: args.description ?? String(cur.description ?? ""),
          metric: args.metric ?? curMetric,
          dueDate: args.dueDate ?? curDate,
          dueOdometer: args.dueOdometer ?? curOdo,
          notes: args.notes ?? String(cur.notes ?? ""),
          tags: args.tags ?? String(cur.tags ?? ""),
        };
        // An unrecognised existing date is passed back verbatim; LubeLogger parses its own format.
        const rawDate = next.dueDate ?? (cur.dueDate ? String(cur.dueDate) : undefined);
        checkMetric(next.metric, rawDate ?? null, next.dueOdometer);
        const { warnings, latest } = await dueWarnings(deps, v.id, next.metric, next.dueDate, next.dueOdometer);

        // LubeLogger overwrites both due fields on update, so always send them to keep the unused one intact.
        const body: Record<string, unknown> = {
          id: Number(cur.id),
          description: next.description,
          metric: next.metric,
          ...(rawDate !== undefined ? { dueDate: rawDate } : {}),
          dueOdometer: next.dueOdometer ?? 0,
          notes: next.notes,
          tags: next.tags,
        };

        const row = (label: string, before: string, after: string) =>
          before === after ? `- ${label}: ${after || "(none)"}` : `- ${label}: ${before || "(none)"} -> ${after || "(none)"} (CHANGED)`;
        const rows = [
          row("Description", String(cur.description ?? ""), next.description),
          row("Due", describeDue(curMetric, curDate, curOdo), describeDue(next.metric, next.dueDate, next.dueOdometer)),
          row("Notes", String(cur.notes ?? ""), next.notes),
          row("Tags", String(cur.tags ?? ""), next.tags),
        ];
        if (!rows.some((r) => r.endsWith("(CHANGED)"))) warnings.push("Nothing changes compared to the current reminder.");

        const rec = pending.add({ kind: "reminderUpdate", vehicleId: v.id, vehicleLabel: vehicleLabel(v), body });
        return previewText(
          deps,
          rec.token,
          [
            `- Type: Reminder update (id ${String(cur.id)}, currently ${String(cur.urgency ?? "?")})`,
            `- Vehicle: ${vehicleLabel(v)} [id ${v.id}]`,
            ...rows,
            `- Latest odometer on file: ${latest === null ? "none" : fmt(latest)}`,
          ],
          warnings,
        );
      }),
  );
}
