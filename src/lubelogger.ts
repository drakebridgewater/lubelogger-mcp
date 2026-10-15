export type RecordKind = "service" | "repair" | "upgrade" | "fuel" | "odometer";

const PATHS: Record<RecordKind, string> = {
  service: "servicerecords",
  repair: "repairrecords",
  upgrade: "upgraderecords",
  fuel: "gasrecords",
  odometer: "odometerrecords",
};

export interface Vehicle {
  id: number;
  year?: number | string;
  make?: string;
  model?: string;
  licensePlate?: string;
  [key: string]: unknown;
}

export interface OperationResponse {
  success?: boolean;
  message?: string;
  [key: string]: unknown;
}

export class LubeLoggerError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** True when LubeLogger definitively rejected the request (nothing was written). */
    readonly definitive: boolean,
  ) {
    super(message);
    this.name = "LubeLoggerError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class LubeLoggerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  private async request(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<unknown> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "x-api-key": this.apiKey,
          // Presence of this header makes LubeLogger return numbers/ISO dates instead of locale strings.
          "culture-invariant": "true",
          accept: "application/json",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new LubeLoggerError(
        `Could not reach LubeLogger at ${this.baseUrl} (${reason}).` +
          (method === "POST" ? " The record may or may not have been saved; check LubeLogger before retrying." : ""),
        null,
        false,
      );
    }

    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body, keep raw text */
    }

    if (!res.ok) {
      const detail =
        data && typeof data === "object" && "message" in data ? String((data as OperationResponse).message) : text.slice(0, 300);
      const hint =
        res.status === 401 || res.status === 403
          ? " (check LUBELOGGER_API_KEY and that the key's role allows adding records: Editor or higher)"
          : "";
      throw new LubeLoggerError(
        `LubeLogger returned HTTP ${res.status}: ${detail || res.statusText}${hint}`,
        res.status,
        res.status >= 400 && res.status < 500,
      );
    }

    // LubeLogger sometimes reports failures as 200 + { success: false }.
    if (data && typeof data === "object" && (data as OperationResponse).success === false) {
      throw new LubeLoggerError(`LubeLogger rejected the request: ${(data as OperationResponse).message ?? "unknown reason"}`, res.status, true);
    }
    return data;
  }

  async listVehicles(): Promise<Vehicle[]> {
    const data = await this.request("GET", "/api/vehicles");
    if (!Array.isArray(data)) throw new LubeLoggerError("Unexpected response from /api/vehicles (expected a list).", null, false);
    return data as Vehicle[];
  }

  /**
   * Latest known odometer for a vehicle: the highest reading across LubeLogger's own "latest" endpoint and every
   * record type we can read. Depending on version and the auto-insert setting, the endpoint can lag behind
   * fuel/service records, so it alone is not trusted. Null if nothing has a reading; throws only if every source failed.
   */
  async getLatestOdometer(vehicleId: number): Promise<number | null> {
    const sources: Promise<number[]>[] = [
      this.request("GET", "/api/vehicle/odometerrecords/latest", { query: { vehicleId } }).then((d) => [toOdometer(d)]),
      ...(Object.keys(PATHS) as RecordKind[]).map((kind) =>
        this.listRecords(kind, vehicleId).then((records) => records.map((r) => toOdometer(r.odometer))),
      ),
    ];
    const results = await Promise.allSettled(sources);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length === results.length) throw failures[0]!.reason;

    const readings = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const max = Math.max(0, ...readings.filter((n) => Number.isFinite(n)));
    return max > 0 ? max : null;
  }

  async listRecords(kind: RecordKind, vehicleId: number): Promise<Record<string, unknown>[]> {
    const data = await this.request("GET", `/api/vehicle/${PATHS[kind]}`, { query: { vehicleId } });
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  }

  async addRecord(kind: RecordKind, vehicleId: number, body: Record<string, unknown>): Promise<OperationResponse> {
    const data = await this.request("POST", `/api/vehicle/${PATHS[kind]}/add`, { query: { vehicleId }, body });
    return (data && typeof data === "object" ? data : { message: String(data ?? "") }) as OperationResponse;
  }
}

function toOdometer(value: unknown): number {
  return Number(typeof value === "string" ? value.replace(/[^0-9.\-]/g, "") : value);
}

export function vehicleLabel(v: Vehicle): string {
  const base = [v.year, v.make, v.model].filter(Boolean).join(" ") || `Vehicle ${v.id}`;
  return v.licensePlate ? `${base} (${v.licensePlate})` : base;
}

/** Resolve a vehicle from an id or any part of its name/plate. Throws a helpful error if ambiguous. */
export function resolveVehicle(vehicles: Vehicle[], query: string | number): Vehicle {
  if (vehicles.length === 0) {
    throw new Error("LubeLogger returned no vehicles for this API key. Add a vehicle first, or check the key's access.");
  }
  const q = String(query).trim().toLowerCase();
  const byId = vehicles.find((v) => String(v.id) === q);
  if (byId) return byId;

  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = vehicles.filter((v) => {
    const hay = vehicleLabel(v).toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  if (matches.length === 1) return matches[0]!;

  const options = (matches.length ? matches : vehicles).map((v) => `  - id ${v.id}: ${vehicleLabel(v)}`).join("\n");
  throw new Error(
    matches.length
      ? `"${query}" matches more than one vehicle. Ask the user which one:\n${options}`
      : `No vehicle matches "${query}". Known vehicles:\n${options}`,
  );
}
