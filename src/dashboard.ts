// Local web dashboard server ("Cadence").
//
// A tiny dependency-free Node HTTP server (bound to localhost) that wraps the
// same commands as the MCP server, plus an auto-login flow and a recovery
// snapshot. It serves a single embedded HTML page (dashboard-ui.ts) and a small
// JSON API the page talks to. Start it with: `garmin-connect-mcp dashboard`.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import {
  getSharedClient,
  sessionExists,
  resetSharedClient,
  getSessionFile,
  GarminClient,
} from "./garmin-client.js";
import { COMMAND_MAP, serializeCommands, RunContext } from "./commands.js";
import { performLogin } from "./dashboard-login.js";
import { METRICS } from "./recovery-metrics.js";
import { DASHBOARD_HTML } from "./dashboard-ui.js";

class NoSessionError extends Error {
  readonly code = "NO_SESSION";
  constructor() {
    super("No Garmin session. Log in first.");
  }
}

function today(): string {
  // Local calendar day (the dashboard runs on the user's own machine), so
  // "today" matches the user's clock rather than rolling over at UTC midnight.
  const d = new Date();
  const p = (n: number): string => (n < 10 ? "0" : "") + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function makeContext(args: Record<string, unknown>): RunContext {
  return {
    args,
    today: today(),
    requireClient: (): GarminClient => {
      if (!sessionExists()) throw new NoSessionError();
      return getSharedClient();
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Fetch the recovery-metric snapshot for one date (all metrics, one round-trip). */
async function snapshot(date: string): Promise<unknown> {
  if (!sessionExists()) {
    return { authenticated: false, date, metrics: [] };
  }
  const client = getSharedClient();
  const metrics: Array<{
    key: string;
    label: string;
    unit: string;
    higherIsBetter: boolean;
    value: number | null;
  }> = [];
  for (const def of Object.values(METRICS)) {
    let value: number | null = null;
    try {
      value = def.extract(await def.fetch(client, date));
    } catch {
      value = null;
    }
    metrics.push({
      key: def.key,
      label: def.label,
      unit: def.unit,
      higherIsBetter: def.higherIsBetter,
      value,
    });
  }
  return { authenticated: true, date, metrics };
}

let loginInFlight = false;

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams
): Promise<void> {
  // GET /api/status
  if (pathname === "/api/status" && req.method === "GET") {
    sendJson(res, 200, {
      authenticated: sessionExists(),
      today: today(),
      sessionFile: getSessionFile(),
    });
    return;
  }

  // GET /api/commands
  if (pathname === "/api/commands" && req.method === "GET") {
    sendJson(res, 200, { commands: serializeCommands() });
    return;
  }

  // GET /api/snapshot?date=
  if (pathname === "/api/snapshot" && req.method === "GET") {
    if (loginInFlight) {
      sendJson(res, 200, {
        authenticated: false,
        date: query.get("date") || today(),
        metrics: [],
        busy: true,
      });
      return;
    }
    const date = query.get("date") || today();
    try {
      sendJson(res, 200, await snapshot(date));
    } catch (e) {
      sendJson(res, 200, {
        authenticated: sessionExists(),
        date,
        metrics: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  // POST /api/run  { command, args }
  if (pathname === "/api/run" && req.method === "POST") {
    if (loginInFlight) {
      sendJson(res, 200, {
        ok: false,
        error: "A login is in progress — finish it in the browser, then retry.",
      });
      return;
    }
    let payload: { command?: string; args?: Record<string, unknown> };
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
      return;
    }
    const cmd = payload.command ? COMMAND_MAP.get(payload.command) : undefined;
    if (!cmd) {
      sendJson(res, 404, {
        ok: false,
        error: `Unknown command "${payload.command}"`,
      });
      return;
    }
    if (cmd.needsAuth && !sessionExists()) {
      sendJson(res, 200, {
        ok: false,
        needsLogin: true,
        error: "This command needs a Garmin session. Log in first.",
      });
      return;
    }
    try {
      const ctx = makeContext(payload.args ?? {});
      const result = await cmd.run(ctx);
      sendJson(res, 200, { ok: true, result });
    } catch (e) {
      const isNoSession =
        e instanceof Error && (e as { code?: string }).code === "NO_SESSION";
      sendJson(res, 200, {
        ok: false,
        needsLogin: isNoSession,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return;
  }

  // POST /api/login
  if (pathname === "/api/login" && req.method === "POST") {
    if (loginInFlight) {
      sendJson(res, 200, {
        ok: false,
        error:
          "A login is already in progress. Finish it in the browser window.",
      });
      return;
    }
    loginInFlight = true;
    try {
      const result = await performLogin();
      if (result.ok) await resetSharedClient();
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      loginInFlight = false;
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

function openBrowser(url: string): void {
  if (process.env.GARMIN_DASHBOARD_NO_OPEN) return;
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* opening the browser is best-effort */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

export async function startDashboard(): Promise<void> {
  const port = Number(process.env.GARMIN_DASHBOARD_PORT) || 8765;
  const host = "127.0.0.1";

  const server = createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", `http://${host}:${port}`);
    const pathname = parsed.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (pathname.startsWith("/api/")) {
      handleApi(req, res, pathname, parsed.searchParams).catch((e) => {
        sendJson(res, 500, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  // The /api/login flow can take minutes (the user logs in by hand), so allow a
  // generous-but-bounded request timeout that still exceeds performLogin's own
  // 5-minute cap, rather than disabling timeouts entirely. headersTimeout keeps
  // its sane Node default.
  server.requestTimeout = 6.5 * 60 * 1000;

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  const url = `http://${host}:${port}`;
  console.error(`\n  Cadence dashboard running at ${url}`);
  console.error(
    sessionExists()
      ? "  Garmin session found — recovery data will load.\n"
      : "  No Garmin session yet — click the auth pill in the dashboard to log in.\n"
  );
  openBrowser(url);
}
