import { z } from "zod";

const schema = z.object({
  LUBELOGGER_URL: z
    .string()
    .url("must be a full URL, e.g. http://lubelogger:8080")
    .transform((v) => v.replace(/\/+$/, "")),
  LUBELOGGER_API_KEY: z.string().min(1, "is required (create one in LubeLogger, Editor role is enough)"),
  /** Optional bearer token required on the MCP endpoint. */
  MCP_AUTH_TOKEN: z.string().min(16, "should be at least 16 characters").optional(),
  /** Endpoint path. Use a long random path (e.g. /mcp/<random>) if you expose this publicly without a bearer token. */
  MCP_PATH: z
    .string()
    .default("/mcp")
    .refine((p) => p.startsWith("/"), "must start with /"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  CONFIRM_TTL_MINUTES: z.coerce.number().positive().default(30),
  REQUEST_TIMEOUT_MS: z.coerce.number().positive().default(15_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (common with docker compose ${VAR:-}) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`).join("\n");
    console.error(`Invalid configuration:\n${problems}`);
    process.exit(1);
  }
  return parsed.data;
}
