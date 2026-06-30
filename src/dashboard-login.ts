// Headful Garmin login for the dashboard.
//
// Adapted from auth.ts (the CLI `login` command), but instead of blocking on a
// terminal keypress it polls the page until login is detectable (CSRF meta tag
// present + Garmin auth cookies set), then captures the session automatically.
// This is what lets the dashboard offer a one-click "Log in" button.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSessionDir, getSessionFile } from "./garmin-client.js";

export interface LoginResult {
  ok: boolean;
  method: "chrome-profile" | "fresh-chromium";
  cookies: number;
  csrf: boolean;
  message: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const AUTH_COOKIE_RE = /SESSIONID|GARMIN-SSO|JWT_FGP|GARMIN-SSO-CUST-GUID/i;

const CSRF_EVAL =
  "() => document.querySelector('meta[name=\"csrf-token\"]')?.content ?? null";

/**
 * Open a real browser, let the user log in to Garmin Connect, and capture the
 * session automatically once login completes. Returns when the session is saved
 * or the timeout elapses.
 */
export async function performLogin(
  opts: { timeoutMs?: number; onProgress?: (msg: string) => void } = {}
): Promise<LoginResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const log = (msg: string): void => {
    console.error(`[login] ${msg}`);
    opts.onProgress?.(msg);
  };

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Playwright is required for login. Install: npm install playwright && npx playwright install chromium"
    );
  }

  // Prefer the user's real Chrome profile (best Cloudflare bypass); fall back to
  // a fresh Playwright Chromium if Chrome is unavailable or locked (already open).
  const chromeDataDir = join(
    homedir(),
    "Library/Application Support/Google/Chrome"
  );
  let method: LoginResult["method"] = "fresh-chromium";
  let browser: any = null;
  let context: any;

  if (existsSync(chromeDataDir)) {
    try {
      log(
        "Opening your Chrome profile (close other Chrome windows if this hangs)…"
      );
      context = await playwright.chromium.launchPersistentContext(
        chromeDataDir,
        { headless: false, channel: "chrome" }
      );
      method = "chrome-profile";
    } catch {
      log(
        "Chrome profile unavailable (Chrome may be open) — using a fresh browser instead."
      );
      context = null;
    }
  }

  if (!context) {
    browser = await playwright.chromium.launch({ headless: false });
    context = await browser.newContext();
    method = "fresh-chromium";
  }

  try {
    const page = await context.newPage();
    log("Navigating to Garmin Connect — log in if prompted…");
    await page.goto("https://connect.garmin.com/app/activities", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const deadline = Date.now() + timeoutMs;
    let csrf: string | null = null;
    let cookies: { name: string; value: string; domain: string }[] = [];

    while (Date.now() < deadline) {
      await sleep(1500);
      let url = "";
      try {
        url = page.url();
      } catch {
        // page navigating; retry next tick
        continue;
      }
      // Still on the sign-in flow — keep waiting.
      if (url.includes("sso.garmin.com") || url.includes("signin")) continue;
      if (!url.includes("connect.garmin.com")) continue;

      csrf = await page.evaluate(CSRF_EVAL).catch(() => null);
      cookies = await context.cookies().catch(() => []);
      const hasAuth = cookies.some(
        (c) => c.domain?.includes("garmin") && AUTH_COOKIE_RE.test(c.name)
      );
      if (csrf && hasAuth) break;
    }

    const garminCookies = cookies
      .filter((c) => c.domain?.includes("garmin"))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));

    if (!csrf || garminCookies.length === 0) {
      return {
        ok: false,
        method,
        cookies: garminCookies.length,
        csrf: Boolean(csrf),
        message:
          "Timed out waiting for login. Make sure you finished logging in and reached your activities list, then try again.",
      };
    }

    const sessionData = { csrf_token: csrf, cookies: garminCookies };
    mkdirSync(getSessionDir(), { recursive: true, mode: 0o700 });
    writeFileSync(getSessionFile(), JSON.stringify(sessionData, null, 2), {
      mode: 0o600,
    });

    log(`Session saved (${garminCookies.length} cookies) via ${method}.`);
    return {
      ok: true,
      method,
      cookies: garminCookies.length,
      csrf: true,
      message: `Logged in. Saved ${garminCookies.length} cookies to ${getSessionFile()}.`,
    };
  } finally {
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
